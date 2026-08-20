import { NextResponse } from 'next/server'
import { getSessionFromCookie, type SessionUser } from '@/lib/auth/session'
import { hasPermission, hasPermissions } from '@/lib/permissions/check'

export type BookkeepingPermission =
  | 'bookkeeping.access'
  | 'bookkeeping.record'
  | 'bookkeeping.submit'
  | 'bookkeeping.settings'

export type BookkeepingAccess = {
  canAccess: boolean
  canRecord: boolean
  canSubmit: boolean
  canManageSettings: boolean
}

export async function getBookkeepingAccess(user: SessionUser): Promise<BookkeepingAccess> {
  const map = await hasPermissions(user, [
    'bookkeeping.access',
    'bookkeeping.record',
    'bookkeeping.submit',
    'bookkeeping.settings',
  ])
  return {
    canAccess: !!map['bookkeeping.access'],
    canRecord: !!map['bookkeeping.record'],
    canSubmit: !!map['bookkeeping.submit'],
    canManageSettings: !!map['bookkeeping.settings'],
  }
}

type Gate =
  | { error: NextResponse; user?: undefined }
  | { error: null; user: SessionUser }

/** The one gate every admin route in this module opens with. */
export async function requireBookkeepingUser(permission: BookkeepingPermission): Promise<Gate> {
  const user = await getSessionFromCookie()
  if (!user) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  }
  if (!(await hasPermission(user, permission))) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }
  return { error: null, user }
}
