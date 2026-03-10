import { User, Sparkles, Loader2, FileText, Video } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'

const MessageBubble = ({ type, text, image, document, video, isStreaming }) => {
  const isUser = type === 'user'

  // 解析 thinking 標籤（僅用於 AI 回應）
  const parseThinkingContent = (content) => {
    if (!content || isUser) {
      return [{ type: 'output', content }]
    }

    // 檢查是否有結束標籤
    const endThinkIndex = content.indexOf('</think>')
    
    if (endThinkIndex !== -1) {
      // 有結束標籤，分割思考與回答
      let thinkingPart = content.slice(0, endThinkIndex)
      const responsePart = content.slice(endThinkIndex + '</think>'.length)

      // 清理思考部分的開始標籤（如果有的話）
      const startThinkIndex = thinkingPart.indexOf('<think>')
      if (startThinkIndex !== -1) {
        thinkingPart = thinkingPart.slice(startThinkIndex + '<think>'.length)
      }

      return [
        { type: 'thinking', content: thinkingPart.trim() },
        { type: 'output', content: responsePart }
      ]
    }

    // 沒有結束標籤，檢查是否有開始標籤
    const startThinkIndex = content.indexOf('<think>')
    if (startThinkIndex !== -1) {
      // 只有開始標籤，表示正在思考中
      const preThinking = content.slice(0, startThinkIndex)
      const thinkingPart = content.slice(startThinkIndex + '<think>'.length)
      
      const parts = []
      if (preThinking.trim()) {
        parts.push({ type: 'output', content: preThinking })
      }
      parts.push({ type: 'thinking', content: thinkingPart.trim() })
      
      return parts
    }

    // 都沒有，視為普通輸出
    return [{ type: 'output', content }]
  }

  const contentParts = parseThinkingContent(text)

  return (
    <div className={`flex items-start gap-4 ${isUser ? 'flex-row-reverse' : 'flex-row'} animate-in fade-in slide-in-from-bottom-4 duration-500`}>
      {/* 頭像 */}
      <div className={`flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center shadow-xl relative ${
        isUser 
          ? 'bg-gradient-to-br from-accent-cyan to-primary-500' 
          : 'bg-gradient-to-br from-primary-500 to-purple-600'
      }`}>
        {/* 外層光環 */}
        <div className={`absolute inset-0 rounded-full ${
          isUser ? 'bg-accent-cyan/20' : 'bg-primary-500/20'
        } animate-pulse blur-md`}></div>
        
        {isUser ? (
          <User className="w-6 h-6 text-white relative z-10" />
        ) : (
          <Sparkles className="w-6 h-6 text-white relative z-10 animate-glow" />
        )}
      </div>

      {/* 訊息內容 */}
      <div className={`flex-1 max-w-[80%] ${isUser ? 'text-right' : 'text-left'}`}>
        <div className={`inline-block px-6 py-4 rounded-2xl relative overflow-hidden ${
          isUser
            ? 'bg-gradient-to-r from-primary-600 to-purple-600 text-white shadow-xl'
            : 'glass-strong text-white shadow-2xl'
        } transition-all duration-300 hover:scale-[1.02]`}>
          {/* 裝飾性光澤 */}
          {!isUser && (
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none"></div>
          )}
          
          {/* 圖片（僅用戶訊息） */}
          {image && (
            <div className="mb-4">
              <img
                src={image}
                alt="Uploaded"
                className="max-w-[350px] max-h-[350px] rounded-xl shadow-lg"
              />
            </div>
          )}

          {/* 影片（僅用戶訊息） */}
          {video && (
            <div className="mb-4 relative">
              <video
                src={video}
                controls
                className="max-w-[350px] max-h-[250px] rounded-xl shadow-lg object-cover"
                playsInline
              />
              <div className="absolute top-2 left-2 flex items-center gap-1 px-2 py-1 bg-black/60 rounded-lg">
                <Video className="w-3.5 h-3.5 text-white" />
                <span className="text-white text-xs">影片</span>
              </div>
            </div>
          )}

          {/* 文件標記（僅用戶訊息） */}
          {document && (
            <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-cyan-900/40 rounded-xl border border-cyan-400/30">
              <FileText className="w-5 h-5 text-cyan-300 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-white font-medium text-sm truncate" title={document}>
                  {document}
                </p>
                <p className="text-cyan-300/70 text-xs mt-0.5">
                  {document.endsWith('.docx') && 'Word 文件'}
                  {document.endsWith('.pdf') && 'PDF 文件'}
                  {document.endsWith('.txt') && '文字文件'}
                  {document.endsWith('.md') && 'Markdown 文件'}
                </p>
              </div>
            </div>
          )}

          {/* 文字 */}
          <div className="break-words text-base leading-relaxed relative z-10">
            {isUser ? (
              // 用戶訊息：保持原樣
              <div className="whitespace-pre-wrap">
                {text}
              </div>
            ) : (
              // AI 回應：處理 thinking 標籤和 Markdown
              <div className="space-y-3">
                {contentParts.map((part, idx) => (
                  part.type === 'thinking' ? (
                    // Thinking 部分：灰色、斜體
                    <div 
                      key={idx} 
                      className="text-gray-400 italic text-sm border-l-2 border-gray-500 pl-4 py-2 bg-gray-900/30 rounded"
                    >
                      <div className="text-gray-500 font-semibold mb-1 text-xs uppercase tracking-wide">
                        💭 思考過程
                      </div>
                      <div className="whitespace-pre-wrap">
                        {part.content}
                      </div>
                    </div>
                  ) : part.content ? (
                    // 輸出部分：Markdown 渲染、白色文字
                    <div key={idx} className="markdown-content text-white">
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        rehypePlugins={[rehypeHighlight]}
                        components={{
                          // 自定義樣式
                          p: ({node, ...props}) => <p className="mb-2 last:mb-0" {...props} />,
                          h1: ({node, ...props}) => <h1 className="text-2xl font-bold mb-3 mt-4 first:mt-0" {...props} />,
                          h2: ({node, ...props}) => <h2 className="text-xl font-bold mb-2 mt-3 first:mt-0" {...props} />,
                          h3: ({node, ...props}) => <h3 className="text-lg font-semibold mb-2 mt-3 first:mt-0" {...props} />,
                          ul: ({node, ...props}) => <ul className="list-disc list-inside mb-2 space-y-1" {...props} />,
                          ol: ({node, ...props}) => <ol className="list-decimal list-inside mb-2 space-y-1" {...props} />,
                          li: ({node, ...props}) => <li className="ml-2" {...props} />,
                          code: ({node, inline, ...props}) => 
                            inline ? (
                              <code className="bg-purple-900/40 px-1.5 py-0.5 rounded text-cyan-300 text-sm" {...props} />
                            ) : (
                              <code className="block bg-gray-900/60 p-3 rounded-lg overflow-x-auto text-sm my-2" {...props} />
                            ),
                          pre: ({node, ...props}) => <pre className="my-2 overflow-x-auto" {...props} />,
                          blockquote: ({node, ...props}) => (
                            <blockquote className="border-l-4 border-primary-500 pl-4 italic text-gray-300 my-2" {...props} />
                          ),
                          table: ({node, ...props}) => (
                            <div className="overflow-x-auto my-2">
                              <table className="min-w-full border border-gray-600" {...props} />
                            </div>
                          ),
                          th: ({node, ...props}) => <th className="border border-gray-600 px-3 py-2 bg-gray-800" {...props} />,
                          td: ({node, ...props}) => <td className="border border-gray-600 px-3 py-2" {...props} />,
                        }}
                      >
                        {part.content}
                      </ReactMarkdown>
                    </div>
                  ) : null
                ))}
              </div>
            )}
            {isStreaming && (
              <span className="inline-block ml-1 animate-pulse text-primary-300">▋</span>
            )}
          </div>
        </div>
        
        {/* 載入指示器 */}
        {isStreaming && !text && (
          <div className="inline-flex items-center gap-3 px-6 py-4 glass-strong rounded-2xl text-primary-200 shadow-xl">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-base">思考中...</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default MessageBubble
