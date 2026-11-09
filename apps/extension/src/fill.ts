// The only code that runs inside a web page (decisions/0029). It is injected
// with chrome.scripting.executeScript into the top frame of the tab the person
// acted on, and given one username and one password, nothing else.
//
// It must be self-contained: executeScript serialises the function, so it
// cannot close over anything or import anything.

export function fillLogin(username: string, password: string, expectedOrigin: string): { filled: number; reason?: string } {
  // The background matched the item to the tab's URL; the tab may have
  // navigated since. Check again, here, before writing anything.
  if (location.origin !== expectedOrigin) return { filled: 0, reason: 'origin' }

  const shown = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  const inputs = Array.from(document.querySelectorAll('input')).filter((i) => !i.disabled && !i.readOnly && shown(i))
  const textual = (i: HTMLInputElement) => ['text', 'email', 'tel', ''].includes(i.type) || i.autocomplete === 'username'
  const named = (i: HTMLInputElement) => /user|email|login|account|identifier/i.test(`${i.autocomplete} ${i.name} ${i.id}`)

  // A page's own frameworks listen for input events; set the value the way
  // typing would, through the native setter, then tell them.
  const set = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    el.focus()
    if (setter) setter.call(el, value); else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const pw = inputs.find((i) => i.type === 'password') ?? null
  let user: HTMLInputElement | null = null
  if (pw) {
    const scope = pw.form ? inputs.filter((i) => i.form === pw.form) : inputs
    const before = scope.slice(0, scope.indexOf(pw)).filter(textual)
    user = before.find(named) ?? before[before.length - 1] ?? null
  } else {
    // The first step of a two-step sign-in: only the address is asked for.
    user = inputs.find((i) => i.autocomplete === 'username') ?? inputs.find((i) => textual(i) && named(i)) ?? null
  }

  let filled = 0
  if (user && username) { set(user, username); filled++ }
  if (pw && password) { set(pw, password); filled++ }
  if (pw) pw.focus()
  return { filled }
}
