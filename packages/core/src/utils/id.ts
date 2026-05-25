import { randomUUID } from 'node:crypto'

/**
 * Generate a unique ID for messages, sessions, plans, etc.
 * Uses crypto.randomUUID() (Node 14.17+, browsers via Web Crypto).
 */
export function generateId(): string {
  return randomUUID()
}
