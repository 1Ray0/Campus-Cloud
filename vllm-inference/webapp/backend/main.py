"""
FastAPI Web 服務 - 提供 React UI 和 API 代理
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 導入專案的 API 客戶端
import sys
sys.path.append(str(Path(__file__).parent.parent.parent))

from api.client import ModelClient
from config.settings import get_settings

# 初始化
app = FastAPI(title="vLLM Web UI", version="1.0.0")
settings = get_settings()
client = ModelClient(settings)

# CORS 設定 (開發時允許所有來源)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================================
# Pydantic 模型
# ============================================================

class ChatRequest(BaseModel):
    """聊天請求 - 預設值從 settings 讀取"""
    message: str
    max_tokens: int = settings.default_max_tokens
    temperature: float = settings.default_temperature
    top_p: float = settings.default_top_p
    top_k: int = settings.default_top_k
    min_p: float = settings.default_min_p
    presence_penalty: float = settings.default_presence_penalty
    repetition_penalty: float = settings.default_repetition_penalty


class ChatResponse(BaseModel):
    """聊天回應"""
    response: str


# ============================================================
# API 端點
# ============================================================

@app.get("/")
async def root():
    """根路徑"""
    return {
        "service": "vLLM Web UI",
        "model": client.model_name,
        "is_vision_model": client.is_vision_model,
        "status": "running"
    }


@app.get("/api/model-info")
async def model_info():
    """獲取模型資訊"""
    return {
        "model_name": client.model_name,
        "is_vision_model": client.is_vision_model,
        "is_image_capable": client.is_image_capable,
        "api_base": f"http://{settings.api_host}:{settings.api_port}",
    }


@app.get("/api/config")
async def get_config():
    """獲取推論配置 - 給前端使用"""
    return {
        "default_max_tokens": settings.default_max_tokens,
        "default_temperature": settings.default_temperature,
        "document_max_tokens": settings.document_max_tokens,
        "vision_temperature": settings.vision_temperature,
        "default_top_p": settings.default_top_p,
        "default_top_k": settings.default_top_k,
        "default_min_p": settings.default_min_p,
        "default_presence_penalty": settings.default_presence_penalty,
        "default_repetition_penalty": settings.default_repetition_penalty,
        "video_fps": settings.video_fps,
        "video_chunk_size": settings.max_video_frames_per_chunk,
    }


@app.post("/api/chat")
async def chat(request: ChatRequest) -> ChatResponse:
    """
    文字聊天 (非流式)
    """
    try:
        response = await client.achat_simple(
            prompt=request.message,
            max_tokens=request.max_tokens,
            temperature=request.temperature,
            top_p=request.top_p,
            top_k=request.top_k,
            min_p=request.min_p,
            presence_penalty=request.presence_penalty,
            repetition_penalty=request.repetition_penalty,
        )
        return ChatResponse(response=response)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    文字聊天 (流式)
    Server-Sent Events (SSE) 格式
    """
    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            async for chunk in client.achat_stream(
                prompt=request.message,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
                top_p=request.top_p,
                top_k=request.top_k,
                min_p=request.min_p,
                presence_penalty=request.presence_penalty,
                repetition_penalty=request.repetition_penalty,
            ):
                # SSE 格式: data: {content}\n\n (JSON Escape for robust newline handling)
                yield f"data: {json.dumps(chunk)}\n\n"
            
            # 結束標記
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: [ERROR] {str(e)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/chat/vision")
async def chat_vision(
    message: str = Form(...),
    image: UploadFile = File(...),
    max_tokens: int = Form(settings.default_max_tokens),
    temperature: float = Form(settings.vision_temperature),
):
    """
    視覺聊天 (非流式)
    上傳圖片 + 文字提示
    """
    if not client.is_image_capable:
        raise HTTPException(
            status_code=400,
            detail="當前模型不支援視覺輸入"
        )

    try:
        # 讀取圖片
        image_bytes = await image.read()
        
        # 轉換為 Base64
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        
        # 構建多模態內容
        from utils.image_utils import create_multimodal_content_from_base64
        
        content = create_multimodal_content_from_base64(
            text=message,
            image_base64=image_b64,
            mime_type=image.content_type or "image/jpeg"
        )
        
        # 呼叫模型
        messages = [{"role": "user", "content": content}]
        response = await client.achat(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=False,
        )
        
        return ChatResponse(response=response.choices[0].message.content or "")
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat/vision/stream")
async def chat_vision_stream(
    message: str = Form(...),
    image: UploadFile = File(...),
    max_tokens: int = Form(settings.default_max_tokens),
    temperature: float = Form(settings.vision_temperature),
):
    """
    視覺聊天 (流式)
    上傳圖片 + 文字提示，流式返回
    """
    if not client.is_image_capable:
        raise HTTPException(
            status_code=400,
            detail="當前模型不支援視覺輸入"
        )

    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            # 讀取圖片
            image_bytes = await image.read()
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")
            
            # 構建多模態內容
            from utils.image_utils import create_multimodal_content_from_base64
            
            content = create_multimodal_content_from_base64(
                text=message,
                image_base64=image_b64,
                mime_type=image.content_type or "image/jpeg"
            )
            
            # 呼叫模型
            messages = [{"role": "user", "content": content}]
            stream = await client.achat(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True,
            )
            
            # 流式輸出
            async for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield f"data: {json.dumps(delta)}\n\n"
            
            yield "data: [DONE]\n\n"
        
        except Exception as e:
            yield f"data: [ERROR] {str(e)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/chat/document/stream")
async def chat_document_stream(
    message: str = Form(...),
    document: UploadFile = File(...),
    max_tokens: int = Form(settings.document_max_tokens),
    temperature: float = Form(settings.default_temperature),
):
    """
    文件聊天 (流式)
    上傳文件 (DOCX/PDF/TXT) + 文字提示，流式返回
    """
    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            # 讀取文件
            document_bytes = await document.read()
            
            # 提取文件內容
            from utils.document_utils import extract_document, create_document_prompt
            
            result = extract_document(document_bytes, filename=document.filename)
            
            if not result['success']:
                yield f"data: [ERROR] {result['error']}\n\n"
                return
            
            # 構建 System Prompt（策略 C：System + User 角色分離）
            system_prompt = """你是一個智能多功能助手，具備以下能力：

**核心功能**：
1. 💬 **對話交流** - 回答各類問題，進行自然對話
2. 📄 **文件分析** - 理解和分析 Word、PDF、TXT 等文件內容
3. 🖼️ **圖片理解** - 識別和描述圖片內容（如果模型支援）

**工作原則**：
- 基於提供的文件內容進行回答，保持準確性
- 引用具體段落或章節支撐你的觀點
- 如果文件中沒有相關信息，明確告知用戶
- 不要添加文件之外的假設或信息
- 以清晰、結構化的方式組織回答

**回答格式**：
- 使用標題、列表、重點標記使回答易讀
- 複雜內容提供分段說明
- 必要時引用原文片段"""

            # 構建用戶消息（包含文件內容和問題）
            user_content = create_document_prompt(
                document_content=result['content'],
                user_message=message,
                file_type=result['file_type']
            )
            
            # 構建消息列表
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content}
            ]
            
            # 呼叫模型（流式）
            stream = await client.achat(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True,
            )
            
            # 流式輸出
            async for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    yield f"data: {json.dumps(delta)}\n\n"
            
            yield "data: [DONE]\n\n"
        
        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()
            print(f"[ERROR] 文件處理失敗: {error_detail}")
            yield f"data: [ERROR] {str(e)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )



@app.post("/api/chat/video/info")
async def chat_video_info(
    video: UploadFile = File(...),
):
    """
    影片預檢 - 回傳影片元資料與預估分段數
    前端可在上傳影片後即時顯示資訊
    """
    if not client.is_image_capable:
        raise HTTPException(status_code=400, detail="當前模型不支援視覺輸入")

    tmp_path = None
    try:
        video_bytes = await video.read()
        suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="vllm_info_")
        os.close(tmp_fd)
        with open(tmp_path, "wb") as f:
            f.write(video_bytes)

        from utils.video_utils import get_video_info, plan_chunks

        info = get_video_info(tmp_path)
        sample_frames = max(1, int(info.duration_sec * settings.video_fps))
        chunk_plan = plan_chunks(sample_frames, settings.max_video_frames_per_chunk)

        return {
            "duration": round(info.duration_sec, 1),
            "width": info.width,
            "height": info.height,
            "native_fps": round(info.native_fps, 2),
            "total_frames": info.total_frames,
            "sample_frames": sample_frames,
            "num_chunks": chunk_plan.num_chunks,
            "chunk_size": chunk_plan.chunk_size,
            "use_chunked": chunk_plan.use_chunked,
        }
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"影片解析失敗: {str(e)}")
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@app.post("/api/chat/video/stream")
async def chat_video_stream(
    message: str = Form(...),
    video: UploadFile = File(...),
    max_tokens: int = Form(settings.default_max_tokens),
    temperature: float = Form(settings.vision_temperature),
):
    """
    影片聊天 (流式)
    上傳影片 + 文字提示，流式返回 SSE
    自動兼容單段與多段分部推論
    """
    if not client.is_image_capable:
        raise HTTPException(status_code=400, detail="當前模型不支援視覺輸入")

    async def event_generator() -> AsyncGenerator[str, None]:
        tmp_path = None
        try:
            # 儲存上傳影片到 temp 目錄
            video_bytes = await video.read()
            suffix = Path(video.filename or "video.mp4").suffix or ".mp4"
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="vllm_video_")
            os.close(tmp_fd)
            with open(tmp_path, "wb") as f:
                f.write(video_bytes)

            # 影片預檢資訊
            from utils.video_utils import get_video_info, plan_chunks

            try:
                info = get_video_info(tmp_path)
                sample_frames = max(1, int(info.duration_sec * settings.video_fps))
                chunk_plan = plan_chunks(sample_frames, settings.max_video_frames_per_chunk)
                info_payload = {
                    "duration": round(info.duration_sec, 1),
                    "frames": sample_frames,
                    "chunks": chunk_plan.num_chunks,
                }
                yield f"data: [INFO] {json.dumps(info_payload)}\n\n"
            except Exception:
                pass  # 即使預檢失敗，仍繼續推論

            # 流式推論（單段直接流式 / 多段分部後流式彙整段）
            async for token in client.achat_with_video_stream(
                text=message,
                video_path=tmp_path,
                max_tokens=max_tokens,
                temperature=temperature,
            ):
                yield f"data: {json.dumps(token)}\n\n"

            yield "data: [DONE]\n\n"

        except Exception as e:
            import traceback
            print(f"[ERROR] 影片處理失敗: {traceback.format_exc()}")
            yield f"data: [ERROR] {str(e)}\n\n"
        finally:
            if tmp_path:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


# ============================================================
# 靜態檔案 (React build)
# ============================================================

# 生產環境：掛載 React build 目錄
frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=3000,
        reload=True,
    )
