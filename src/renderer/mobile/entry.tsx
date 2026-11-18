import React from 'react'
import ReactDOM from 'react-dom/client'
import DeepSeekMobileApp from './DeepSeekMobileApp'
import './mobile.css'

ReactDOM.createRoot(document.getElementById('mobile-root') as HTMLElement).render(
  <React.StrictMode>
    <DeepSeekMobileApp />
  </React.StrictMode>
)
