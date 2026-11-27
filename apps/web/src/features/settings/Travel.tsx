// Travel mode (Settings → Security): before crossing a border, mark the vaults
// that may travel and turn it on. The server then stops serving every other
// vault to every device of the account, until it is turned off again — which
// asks for the master password (the server's sudo window).

import { useEffect, useState } from 'react'

import { openVaults } from '@vault/crypto'

import { ApiError, type TravelState, api } from '../../lib/api.js'
import * as session from '../../lib/session.js'
import { IconAlert, IconGlobe } from '../../ui/icons.js'
import { Check, useToast } from '../../ui/kit.js'
import { ReauthPrompt } from '../admin/Reauth.js'

const PERSONAL = 'personal'

export function Travel({ state }: { state: session.Unlocked }) {
  const toast = useToast()
  const [travel, setTravel] = useState<TravelState | null>(null)
  const [vaults, setVaults] = useState<{ id: string; name: string }[]>([])
  const [busy, setBusy] = useState(false)

  async function load() {
    const v = await api.vault(await session.token())
    const opened = await openVaults(v.vaults ?? [], state.vaultKey)
    setVaults([{ id: PERSONAL, name: 'Personal' }, ...opened.map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name))])
    setTravel(v.travel ?? { on: false, safe: [] })
  }
  useEffect(() => { void load().catch(() => setTravel({ on: false, safe: [] })) }, [state.vaultKey])

  async function change(body: { on?: boolean; safe?: string[] }, done: string) {
    setBusy(true)
    try {
      setTravel(await api.setTravel(await session.token(), body))
      await load()
      toast(done)
    } catch (err) {
      toast(err instanceof ApiError && err.code === 'reauth_required' ? 'Confirm your master password to bring vaults back.' : err instanceof Error ? err.message : 'Could not change travel mode.', 'error')
    } finally { setBusy(false) }
  }

  if (!travel) return null
  const safe = new Set(travel.safe)
  const away = vaults.filter((v) => !safe.has(v.id))
  const toggleSafe = (id: string, on: boolean) => {
    const next = on ? [...safe, id] : [...safe].filter((x) => x !== id)
    void change({ safe: next }, on ? 'Marked safe for travel' : 'No longer safe for travel')
  }

  return (
    <section className={`settings-card travel-card ${travel.on ? 'travel-on' : ''}`} aria-labelledby="s-travel">
      <ReauthPrompt />
      <div className="settings-card-head"><IconGlobe size={18} /><h2 id="s-travel">Travel mode</h2>
        <span className={`pill ${travel.on ? 'pill-accent' : ''}`}>{travel.on ? 'On' : 'Off'}</span></div>
      <p className="muted small">
        Crossing a border, or lending a device? Mark the vaults that may travel, then turn this on. Every other vault disappears from
        this browser, the extension, the command line and any new offline copy, on every device, until you turn it off again with
        your master password. Nothing is deleted.
      </p>

      <ul className="travel-vaults" aria-label="Vaults">
        {vaults.map((v) => (
          <li key={v.id}>
            <span className="travel-name">{v.name}</span>
            <Check checked={safe.has(v.id)} onChange={(on) => toggleSafe(v.id, on)}>Safe for travel</Check>
          </li>
        ))}
      </ul>
      {travel.on ? <p className="muted small">Vaults away for travel are not listed here; they come back when you turn it off.</p> : null}

      {travel.on ? (
        <div className="settings-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void change({ on: false }, 'Travel mode is off. Every vault is back.')}>Turn off travel mode</button>
        </div>
      ) : (
        <>
          {away.length ? <p className="alert alert-warn"><IconAlert size={16} /><span>Turning it on removes {away.map((v) => `“${v.name}”`).join(', ')} from every device until you turn it off.</span></p> : null}
          <div className="settings-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void change({ on: true }, 'Travel mode is on.')}>Turn on travel mode</button>
          </div>
        </>
      )}
    </section>
  )
}
