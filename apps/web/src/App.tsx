import { useEffect, useState } from 'react'

import * as session from './session.js'
import { Unlock } from './pages/Unlock.js'
import { Register } from './pages/Register.js'
import { Vault } from './pages/Vault.js'

type View = 'unlock' | 'register'

export function App() {
  const [unlocked, setUnlocked] = useState(session.get())
  const [view, setView] = useState<View>('unlock')

  useEffect(() => session.subscribe(setUnlocked), [])

  if (unlocked) return <Vault state={unlocked} />

  return (
    <main>
      <h1>Vault</h1>
      <p className="sub">
        Encryption happens here. The master password never reaches the server.
      </p>
      {view === 'unlock' ? (
        <Unlock onRegister={() => setView('register')} />
      ) : (
        <Register onDone={() => setView('unlock')} onCancel={() => setView('unlock')} />
      )}
    </main>
  )
}
