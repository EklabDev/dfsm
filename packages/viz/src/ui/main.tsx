import { createRoot } from 'react-dom/client'
import { App } from './App.js'

const el = document.getElementById('root')
if (!el) {
  throw new Error('Missing #root element')
}

createRoot(el).render(<App />)
