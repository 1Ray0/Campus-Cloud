"""AI 對話 API 的資料模型"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """POST /api/v1/chat 請求體"""

    message: str | None = Field(
        default=None, description="使用者輸入的自然語言問題", max_length=2000
    )
    messages: list[dict] | None = Field(
        default=None, description="完整的對話歷史（用於中斷與接續對話）"
    )


class ToolCallRecord(BaseModel):
    """記錄一次工具呼叫的名稱與參數"""

    name: str = Field(description="工具名稱")
    args: dict[str, Any] = Field(default_factory=dict, description="傳入的參數")
    result: dict[str, Any] | None = Field(default=None, description="工具執行結果")


class ChatResponse(BaseModel):
    """POST /api/v1/chat 回應體"""

    reply: str = Field(description="AI 的自然語言回答")
    tools_called: list[ToolCallRecord] = Field(
        default_factory=list, description="本次呼叫用到的工具清單（依呼叫順序）"
    )
    needs_confirmation: bool = Field(
        default=False, description="是否需要使用者確認指令（若為 True，對話將中斷）"
    )
    messages: list[dict] = Field(
        default_factory=list, description="目前的完整對話歷史（前端可帶回以接續對話）"
    )
    error: str | None = Field(default=None, description="若發生錯誤則填入錯誤訊息")
