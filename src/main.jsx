import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { LocationProvider } from './context/LocationContext.jsx'
import { ThemeProvider } from './context/ThemeProvider.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <LocationProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </LocationProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
