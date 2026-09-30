import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme' // 先決定淺色／深色，再畫第一個畫面
import App from './App'
import './remote.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
