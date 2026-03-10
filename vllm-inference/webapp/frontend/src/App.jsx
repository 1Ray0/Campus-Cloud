import { useState, useEffect } from 'react'
import { Sparkles, ImageIcon, Send, Loader2, AlertCircle } from 'lucide-react'
import ChatBox from './components/ChatBox'

function App() {
  const [modelInfo, setModelInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    // 獲取模型資訊
    fetch('/api/model-info')
      .then(res => res.json())
      .then(data => {
        setModelInfo(data)
        setLoading(false)
      })
      .catch(err => {
        setError('無法連接到 vLLM 服務')
        setLoading(false)
      })
  }, [])

  return (
    <div className="min-h-screen relative overflow-hidden bg-gradient-to-br from-primary-900 via-primary-800 to-purple-900">
      {/* 星空背景 */}
      <div className="absolute inset-0 starry-bg opacity-50"></div>
      
      {/* 漸變光暈 - 更多層次 */}
      <div className="absolute top-0 left-0 w-full h-full">
        <div className="absolute top-20 left-20 w-[500px] h-[500px] bg-primary-500/20 rounded-full filter blur-3xl animate-float"></div>
        <div className="absolute bottom-20 right-20 w-[500px] h-[500px] bg-purple-500/20 rounded-full filter blur-3xl animate-float" style={{ animationDelay: '3s' }}></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent-cyan/10 rounded-full filter blur-3xl animate-float" style={{ animationDelay: '6s' }}></div>
        <div className="absolute top-1/3 right-1/4 w-[400px] h-[400px] bg-purple-400/10 rounded-full filter blur-3xl animate-float" style={{ animationDelay: '9s' }}></div>
      </div>

      {/* 主要內容 */}
      <div className="relative z-10 container mx-auto px-4 py-12 max-w-6xl">
        {/* 頂部標題 */}
        <header className="text-center mb-12">
          <div className="inline-flex items-center gap-4 mb-6">
            <Sparkles className="w-12 h-12 text-primary-300 animate-glow" />
            <h1 className="text-6xl font-bold text-white text-glow tracking-wide">
              AI 夢幻助手
            </h1>
            <Sparkles className="w-12 h-12 text-primary-300 animate-glow" />
          </div>
          
          {loading && (
            <div className="flex items-center justify-center gap-2 text-primary-200">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>正在連接...</span>
            </div>
          )}
          
          {error && (
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-red-500/20 border border-red-400/30 rounded-lg text-red-200">
              <AlertCircle className="w-5 h-5" />
              <span>{error}</span>
            </div>
          )}
          
          {modelInfo && (
            <div className="inline-flex items-center gap-3 px-8 py-4 glass rounded-full text-primary-100 shadow-xl hover:shadow-2xl transition-all duration-300">
              <div className="relative">
                <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
                <div className="absolute inset-0 w-3 h-3 bg-green-400 rounded-full animate-ping"></div>
              </div>
              <span className="font-medium text-lg">
                {modelInfo.model_name.split('/').pop()}
              </span>
              {modelInfo.is_image_capable && (
                <>
                  <span className="text-primary-300 text-xl">•</span>
                  <ImageIcon className="w-5 h-5" />
                  <span className="text-base">支援圖片</span>
                </>
              )}
            </div>
          )}
        </header>

        {/* 聊天容器 */}
        {!loading && !error && modelInfo && (
          <ChatBox modelInfo={modelInfo} />
        )}

        {/* 底部資訊 */}
        <footer className="mt-12 text-center text-primary-200/60 text-sm space-y-2">
          <p>powered by vLLM • 單次對話模式 • 不保存歷史記錄</p>
          <p className="text-xs text-primary-300/40">✨ 支援流式輸出 • 📸 圖片辨識 • 🎨 優雅介面</p>
        </footer>
      </div>
    </div>
  )
}

export default App
