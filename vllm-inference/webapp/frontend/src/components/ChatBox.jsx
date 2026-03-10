import { useState, useRef, useEffect } from 'react'
import { Send, ImageIcon, X, Loader2, Upload, Paperclip, FileText, Video } from 'lucide-react'
import MessageBubble from './MessageBubble'

const ChatBox = ({ modelInfo }) => {
  const [message, setMessage] = useState('')
  const [image, setImage] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [document, setDocument] = useState(null)
  const [documentName, setDocumentName] = useState(null)
  const [video, setVideo] = useState(null)
  const [videoPreview, setVideoPreview] = useState(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentResponse, setCurrentResponse] = useState('')
  const [lastUserMessage, setLastUserMessage] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  
  // 配置參數（從後端獲取，避免硬編碼）
  const [config, setConfig] = useState({
    default_max_tokens: 2048,
    default_temperature: 0.7,
    document_max_tokens: 4096,
    vision_temperature: 0.75,
  })
  
  const fileInputRef = useRef(null)
  const documentInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const responseEndRef = useRef(null)
  const dropZoneRef = useRef(null)

  // 獲取配置參數
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setConfig(data))
      .catch(err => console.error('獲取配置失敗:', err))
  }, [])

  // 自動滾動到回應底部
  useEffect(() => {
    if (currentResponse) {
      responseEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [currentResponse])

  // 處理圖片選擇
  const handleImageSelect = (e) => {
    const file = e.target.files?.[0]
    if (file && file.type.startsWith('image/')) {
      setImage(file)
      const reader = new FileReader()
      reader.onload = (e) => setImagePreview(e.target.result)
      reader.readAsDataURL(file)
    }
  }

  // 處理影片選擇
  const handleVideoSelect = (file) => {
    if (!file || !file.type.startsWith('video/')) return
    // 清除圖片和文件（三種媒體互斥）
    setImage(null)
    setImagePreview(null)
    setDocument(null)
    setDocumentName(null)
    setVideo(file)
    setVideoPreview(URL.createObjectURL(file))
  }

  // 處理文件選擇
  const handleDocumentSelect = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      const validExtensions = ['.docx', '.pdf', '.txt', '.md']
      const fileExt = file.name.toLowerCase().substring(file.name.lastIndexOf('.'))
      
      if (validExtensions.includes(fileExt)) {
        setDocument(file)
        setDocumentName(file.name)
        // 清除圖片（文件和圖片互斥）
        setImage(null)
        setImagePreview(null)
      } else {
        alert('不支援的文件格式！請上傳 DOCX、PDF、TXT 或 MD 文件。')
      }
    }
  }

  // 處理拖放
  const handleDragEnter = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isStreaming) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    // 檢查是否真的離開了拖放區域
    if (!dropZoneRef.current?.contains(e.relatedTarget)) {
      setIsDragging(false)
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (isStreaming) return

    const files = e.dataTransfer.files
    if (files.length > 0) {
      const file = files[0]
      const fileName = file.name.toLowerCase()
      
      // 檢查是否為影片
      if (file.type.startsWith('video/') && modelInfo.is_image_capable) {
        handleVideoSelect(file)
      }
      // 檢查是否為圖片
      else if (file.type.startsWith('image/') && modelInfo.is_image_capable) {
        setImage(file)
        const reader = new FileReader()
        reader.onload = (e) => setImagePreview(e.target.result)
        reader.readAsDataURL(file)
        // 清除文件與影片
        setDocument(null)
        setDocumentName(null)
        removeVideo()
      }
      // 檢查是否為文件
      else if (fileName.endsWith('.docx') || fileName.endsWith('.pdf') || 
               fileName.endsWith('.txt') || fileName.endsWith('.md')) {
        setDocument(file)
        setDocumentName(file.name)
        // 清除圖片與影片
        setImage(null)
        setImagePreview(null)
        removeVideo()
      }
    }
  }

  // 移除影片
  const removeVideo = () => {
    if (videoPreview) {
      URL.revokeObjectURL(videoPreview)
    }
    setVideo(null)
    setVideoPreview(null)
    if (videoInputRef.current) {
      videoInputRef.current.value = ''
    }
  }

  // 移除圖片
  const removeImage = () => {
    setImage(null)
    setImagePreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // 移除文件
  const removeDocument = () => {
    setDocument(null)
    setDocumentName(null)
    if (documentInputRef.current) {
      documentInputRef.current.value = ''
    }
  }

  // 處理流式回應的輔助函數
  const processStream = async (reader) => {
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          let data = line.slice(6)
          
          if (data === '[DONE]') {
            setIsStreaming(false)
            return // End processStream
          }
          
          if (data.startsWith('[ERROR]')) {
             throw new Error(data.slice(8))
          }

          // 影片資訊標頭事件
          if (data.startsWith('[INFO]')) {
            try {
              const info = JSON.parse(data.slice(7))
              const header = `> 🎬 影片: ${info.duration}s \u00b7 ${info.frames}幀 \u00b7 ${info.chunks}段\n\n`
              setCurrentResponse(prev => prev + header)
            } catch(e) { /* ignore parse errors */ }
            continue
          }

          try {
             if (data.startsWith('"')) {
                data = JSON.parse(data)
             }
          } catch(e) {
             // ignore
          }
          
          setCurrentResponse(prev => prev + data)
        }
      }
    }
  }

  // 發送訊息（流式）
  const sendMessage = async () => {
    if (!message.trim() && !image && !document) return
    if (isStreaming) return

    // 保存用戶訊息
    setLastUserMessage({
      text: message,
      image: imagePreview,
      document: documentName,
      video: videoPreview,
    })

    // 清空輸入（立即清除預覽）
    const userMessage = message
    const userImage = image
    const userDocument = document
    const userVideo = video
    setMessage('')
    removeImage()  // 立即清除圖片
    removeDocument() // 立即清除文件
    removeVideo()  // 立即清除影片
    setIsStreaming(true)
    setCurrentResponse('')

    try {
      let endpoint
      let body

      if (userDocument) {
        // 文件模式 - 使用 FormData
        endpoint = '/api/chat/document/stream'
        const formData = new FormData()
        formData.append('message', userMessage || '請分析這份文件的內容')
        formData.append('document', userDocument)
        formData.append('max_tokens', String(config.document_max_tokens))
        formData.append('temperature', String(config.default_temperature))

        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          throw new Error('請求失敗')
        }

        // 處理 SSE 流
        await processStream(response.body.getReader())
      } else if (userVideo) {
        // 影片模式 - 使用 FormData
        endpoint = '/api/chat/video/stream'
        const formData = new FormData()
        formData.append('message', userMessage || '請分析這段影片的內容')
        formData.append('video', userVideo)
        formData.append('max_tokens', String(config.default_max_tokens))
        formData.append('temperature', String(config.vision_temperature ?? config.default_temperature))

        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          throw new Error('影片請求失敗')
        }

        // 處理 SSE 流
        await processStream(response.body.getReader())
      } else if (userImage) {
        // 圖片模式 - 使用 FormData
        endpoint = '/api/chat/vision/stream'
        const formData = new FormData()
        formData.append('message', userMessage)
        formData.append('image', userImage)
        formData.append('max_tokens', String(config.default_max_tokens))
        formData.append('temperature', String(config.vision_temperature))

        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          throw new Error('請求失敗')
        }

        // 處理 SSE 流
        await processStream(response.body.getReader())
      } else {
        // 純文字模式
        endpoint = '/api/chat/stream'
        
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: userMessage,
            max_tokens: config.default_max_tokens,
            temperature: config.default_temperature,
          }),
        })

        if (!response.ok) {
          throw new Error('請求失敗')
        }

        // 處理 SSE 流
        await processStream(response.body.getReader())
      }
    } catch (error) {
      console.error('發送失敗:', error)
      setCurrentResponse('❌ 發生錯誤: ' + error.message)
      setIsStreaming(false)
    }
  }

  // 新對話
  const newChat = () => {
    setLastUserMessage(null)
    setCurrentResponse('')
    setMessage('')
    removeImage()
    removeDocument()
    removeVideo()
  }

  // Enter 發送
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div 
      ref={dropZoneRef}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`glass-strong rounded-3xl p-8 shadow-2xl card-glow transition-all duration-300 ${
        isDragging ? 'border-4 border-primary-400 bg-primary-500/30 scale-[1.02]' : ''
      }`}
    >
      {/* 拖放提示覆蓋層 */}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary-900/80 backdrop-blur-sm rounded-3xl">
          <div className="text-center space-y-4">
            <Upload className="w-20 h-20 mx-auto text-primary-300 animate-bounce" />
            <p className="text-2xl font-bold text-white">放開以上傳檔案</p>
            <p className="text-primary-200">支援圖片（JPG、PNG、WebP）</p>
            <p className="text-primary-200">支援影片（MP4、MOV、AVI）</p>
            <p className="text-primary-200">支援文件（DOCX、PDF、TXT、MD）</p>
          </div>
        </div>
      )}

      {/* 對話顯示區 */}
      <div className="min-h-[450px] max-h-[650px] overflow-y-auto custom-scrollbar mb-8 space-y-6 px-2">
        {!lastUserMessage && !currentResponse && (
          <div className="flex items-center justify-center h-full text-primary-200/60">
            <div className="text-center space-y-6">
              <div className="relative">
                <Loader2 className="w-20 h-20 mx-auto animate-spin text-primary-300/50" />
                <div className="absolute inset-0 w-20 h-20 mx-auto animate-ping text-primary-400/30">
                  <Loader2 className="w-20 h-20" />
                </div>
              </div>
              <p className="text-xl font-medium">開始你的魔法對話吧 ✨</p>
              {modelInfo.is_image_capable && (
                <div className="space-y-2">
                  <p className="text-base text-primary-300">支援圖片 & 影片分析 🎬</p>
                  <p className="text-sm text-primary-400/60">可直接拖放圖片 / 影片到此區域</p>
                </div>
              )}
            </div>
          </div>
        )}

        {lastUserMessage && (
          <MessageBubble
            type="user"
            text={lastUserMessage.text}
            image={lastUserMessage.image}
            document={lastUserMessage.document}
            video={lastUserMessage.video}
          />
        )}

        {currentResponse && (
          <MessageBubble
            type="assistant"
            text={currentResponse}
            isStreaming={isStreaming}
          />
        )}
        
        <div ref={responseEndRef} />
      </div>

      {/* 影片預覽 */}
      {videoPreview && (
        <div className="mb-6 relative inline-block group">
          <div className="relative rounded-2xl overflow-hidden border-2 border-violet-400/50 shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105">
            <video
              src={videoPreview}
              className="max-w-[280px] max-h-[180px] object-cover"
              muted
              playsInline
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent"></div>
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
              <Video className="w-4 h-4 text-white" />
              <span className="text-white text-xs font-medium">{video?.name ?? '影片'}</span>
            </div>
          </div>
          <button
            onClick={removeVideo}
            className="absolute -top-3 -right-3 p-2 bg-red-500 rounded-full text-white hover:bg-red-600 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110 button-shine"
            title="移除影片"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* 圖片預覽 */}
      {imagePreview && (
        <div className="mb-6 relative inline-block group">
          <div className="relative rounded-2xl overflow-hidden border-2 border-primary-400/50 shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105">
            <img
              src={imagePreview}
              alt="Preview"
              className="max-w-[250px] max-h-[250px] object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
          </div>
          <button
            onClick={removeImage}
            className="absolute -top-3 -right-3 p-2 bg-red-500 rounded-full text-white hover:bg-red-600 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110 button-shine"
            title="移除圖片"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* 文件預覽 */}
      {documentName && (
        <div className="mb-6 relative inline-block group">
          <div className="relative rounded-2xl overflow-hidden border-2 border-cyan-400/50 bg-cyan-900/30 backdrop-blur-sm shadow-xl hover:shadow-2xl transition-all duration-300 hover:scale-105 p-4 min-w-[250px]">
            <div className="flex items-center gap-3">
              <FileText className="w-10 h-10 text-cyan-300" />
              <div className="flex-1">
                <p className="text-white font-medium text-sm truncate max-w-[180px]" title={documentName}>
                  {documentName}
                </p>
                <p className="text-cyan-300/60 text-xs mt-1">
                  {documentName.endsWith('.docx') && 'Word 文件'}
                  {documentName.endsWith('.pdf') && 'PDF 文件'}
                  {documentName.endsWith('.txt') && '文字文件'}
                  {documentName.endsWith('.md') && 'Markdown 文件'}
                </p>
              </div>
            </div>
          </div>
          <button
            onClick={removeDocument}
            className="absolute -top-3 -right-3 p-2 bg-red-500 rounded-full text-white hover:bg-red-600 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110 button-shine"
            title="移除文件"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* 輸入區 */}
      <div className="flex items-end gap-4">
        <div className="flex-1 glass rounded-2xl p-5 space-y-4 hover:bg-white/25 transition-all duration-300">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={              video ? '描述你想了解這段影片的哪些內容...' :              image ? "描述你想了解的內容..." : 
              document ? "請問關於這份文件的問題..." : 
              "輸入訊息...按 Enter 發送"
            }
            className="w-full bg-transparent text-white placeholder-primary-300/60 resize-none focus:outline-none text-base leading-relaxed"
            rows={3}
            disabled={isStreaming}
          />
          
          <div className="flex items-center gap-3 pt-2 border-t border-white/10">
            {/* 文件上傳 */}
            <input
              ref={documentInputRef}
              type="file"
              accept=".docx,.pdf,.txt,.md"
              onChange={handleDocumentSelect}
              className="hidden"
              disabled={isStreaming}
            />
            <button
              onClick={() => documentInputRef.current?.click()}
              disabled={isStreaming}
              className="group px-5 py-2.5 glass rounded-xl text-primary-200 hover:bg-white/30 transition-all duration-300 flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg button-shine"
              title="上傳文件（DOCX、PDF、TXT、MD）"
            >
              <Paperclip className="w-5 h-5 group-hover:scale-110 transition-transform duration-300" />
              <span className="text-sm font-medium">上傳文件</span>
            </button>

            {/* 影片上傳（僅視覺模型） */}
            {modelInfo.is_image_capable && (
              <>
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/*"
                  onChange={(e) => handleVideoSelect(e.target.files?.[0])}
                  className="hidden"
                  disabled={isStreaming}
                />
                <button
                  onClick={() => videoInputRef.current?.click()}
                  disabled={isStreaming}
                  className="group px-5 py-2.5 glass rounded-xl text-primary-200 hover:bg-white/30 transition-all duration-300 flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg button-shine"
                  title="上傳影片"
                >
                  <Video className="w-5 h-5 group-hover:scale-110 transition-transform duration-300" />
                  <span className="text-sm font-medium">上傳影片</span>
                </button>
              </>
            )}

            {/* 圖片上傳（僅視覺模型） */}
            {modelInfo.is_image_capable && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="hidden"
                  disabled={isStreaming}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming}
                  className="group px-5 py-2.5 glass rounded-xl text-primary-200 hover:bg-white/30 transition-all duration-300 flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg button-shine"
                  title="上傳圖片"
                >
                  <ImageIcon className="w-5 h-5 group-hover:scale-110 transition-transform duration-300" />
                  <span className="text-sm font-medium">上傳圖片</span>
                </button>
              </>
            )}
            
            <span className="text-xs text-primary-300/60">或直接拖放檔案</span>
          </div>
        </div>

        {/* 發送按鈕 */}
        <button
          onClick={sendMessage}
          disabled={(!message.trim() && !image && !document && !video) || isStreaming}
          className="group p-5 bg-gradient-to-r from-primary-600 to-purple-600 rounded-2xl text-white hover:from-primary-500 hover:to-purple-500 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-xl hover:shadow-2xl cursor-pointer hover:scale-105 button-shine"
          title={isStreaming ? "發送中..." : "發送訊息"}
        >
          {isStreaming ? (
            <Loader2 className="w-7 h-7 animate-spin" />
          ) : (
            <Send className="w-7 h-7 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform duration-300" />
          )}
        </button>
      </div>

      {/* 新對話按鈕 */}
      {currentResponse && !isStreaming && (
        <div className="mt-6 text-center">
          <button
            onClick={newChat}
            className="px-8 py-3 glass rounded-xl text-primary-200 hover:bg-white/30 transition-all duration-300 cursor-pointer shadow-lg hover:shadow-xl hover:scale-105 button-shine font-medium"
          >
            ✨ 開始新對話
          </button>
        </div>
      )}
    </div>
  )
}

export default ChatBox
