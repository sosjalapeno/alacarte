import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import './styles/global.css'

import App from './App'
import { LibraryPresenceProvider } from './hooks/useLibraryPresence'
import { QueueProvider } from './hooks/useQueue'

const vinylWarm = new Image()
vinylWarm.src = '/vinyl.webp'
void vinylWarm.decode?.().catch(() => {})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LibraryPresenceProvider>
      <QueueProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueueProvider>
    </LibraryPresenceProvider>
  </React.StrictMode>,
)
