// Checks a content document against the schema. The API runs this on every
// save and publish; the admin panel runs it too, for immediate feedback. The
// server's run is the one that counts.
//
// Unknown keys are dropped. Missing groups and fields are filled from the
// defaults, so a schema that gains a field does not break documents saved
// before it existed.

import { ICONS, safeHref } from './render.mjs'

// Control characters other than newline and tab have no business in page text.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

function checkField(field, value, fallback, path, errors, mediaIds) {
  const v = value === undefined ? fallback : value
  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof v !== 'string') { errors.push({ path, message: 'must be text' }); return fallback ?? '' }
      const s = field.type === 'text' ? v.replace(/\s+/g, ' ').trim() : v.replace(/\r\n?/g, '\n').trim()
      if (CONTROL.test(s)) errors.push({ path, message: 'contains characters that cannot be shown' })
      if (s.length > field.max) errors.push({ path, message: `is ${s.length} characters; the limit is ${field.max}` })
      return s
    }
    case 'bool':
      if (typeof v !== 'boolean') { errors.push({ path, message: 'must be on or off' }); return Boolean(fallback) }
      return v
    case 'select':
      if (!field.options.some(([k]) => k === v)) { errors.push({ path, message: 'is not one of the choices' }); return fallback }
      return v
    case 'icon':
      if (!ICONS.includes(v)) { errors.push({ path, message: 'is not a known icon' }); return fallback ?? 'shield' }
      return v
    case 'link': {
      if (typeof v !== 'string') { errors.push({ path, message: 'must be a link' }); return '' }
      const s = v.trim()
      if (s && safeHref(s) === '#') errors.push({ path, message: 'must be a page on this site (like /features) or an https:// address' })
      if (s.length > 300) errors.push({ path, message: 'is too long' })
      return s
    }
    case 'image':
      if (v === null || v === undefined || v === '') return null
      if (typeof v !== 'string' || !mediaIds.has(v)) { errors.push({ path, message: 'refers to an image that does not exist' }); return null }
      return v
    case 'list': {
      if (!Array.isArray(v)) { errors.push({ path, message: 'must be a list' }); return fallback ?? [] }
      if (v.length < field.min || v.length > field.max) {
        errors.push({ path, message: field.min === field.max ? `must have exactly ${field.min}` : `must have between ${field.min} and ${field.max}` })
      }
      return v.slice(0, field.max).map((item, i) => {
        const out = {}
        const src = item && typeof item === 'object' ? item : {}
        const fb = Array.isArray(fallback) ? fallback[i] ?? fallback[0] ?? {} : {}
        for (const f of field.fields) out[f.key] = checkField(f, src[f.key], fb[f.key], `${path}.${i}.${f.key}`, errors, mediaIds)
        return out
      })
    }
  }
  errors.push({ path, message: 'has an unknown type' })
  return fallback
}

/**
 * @returns {{ content: object, errors: Array<{path: string, message: string}> }}
 */
export function validateContent(schema, input, defaults, mediaIds = new Set()) {
  const errors = []
  const content = {}
  const doc = input && typeof input === 'object' ? input : {}
  for (const section of schema.sections) {
    content[section.id] = {}
    for (const group of section.groups) {
      const src = doc[section.id]?.[group.key] ?? {}
      const fb = defaults[section.id]?.[group.key] ?? {}
      const out = {}
      for (const field of group.fields) {
        const path = `${section.id}.${group.key}.${field.key}`
        out[field.key] = checkField(field, src[field.key], fb[field.key], path, errors, mediaIds)
      }
      content[section.id][group.key] = out
    }
  }
  return { content, errors }
}

/** Image field path -> fallback URL, for the renderer. */
export function imageFallbacks(schema) {
  const out = {}
  for (const section of schema.sections) {
    for (const group of section.groups) {
      for (const field of group.fields) {
        if (field.type === 'image') out[`${section.id}.${group.key}.${field.key}`] = field.fallback
      }
    }
  }
  return out
}

/** Media ids a document refers to, so unused images can be told apart. */
export function referencedMedia(content) {
  const ids = new Set()
  const walk = (v) => {
    if (typeof v === 'string' && /^m_[A-Za-z0-9_-]{16,}$/.test(v)) ids.add(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(content)
  return ids
}
