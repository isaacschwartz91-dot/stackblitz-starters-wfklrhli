/**
 * Role separation (section 2, NFR-3).
 *
 * Three modes behind one shared passcode:
 *   customer — build an order, see compliance and the meal plan. Cannot reach
 *              the catalog editor, program rules, records, or overrides.
 *   staff    — customer plus overrides, price corrections, finalize, reprint.
 *   admin    — everything, including program rules and exports.
 *
 * This is a counter-top role gate, not authentication. NFR-2 is explicit that
 * the moment any identifying member data is stored, this must be replaced
 * with per-user credentials on a server. The tool is built to store only a
 * referral ID and a member count precisely so that line is not crossed.
 */

import { Injectable, computed, signal } from '@angular/core';
import { sha256Hex } from '../../shared/ids';
import { DataStore } from './store';

export type Role = 'customer' | 'staff' | 'admin';

/** Used only until the owner sets a real passcode in Admin. */
export const DEFAULT_PASSCODE = '1234';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly currentRole = signal<Role>('customer');
  private readonly failedAttempts = signal(0);

  readonly role = this.currentRole.asReadonly();
  readonly isStaff = computed(() => this.currentRole() !== 'customer');
  readonly isAdmin = computed(() => this.currentRole() === 'admin');
  readonly attempts = this.failedAttempts.asReadonly();

  constructor(private readonly store: DataStore) {}

  /** True while the store is still using the shipped default passcode. */
  readonly usingDefaultPasscode = computed(() => this.store.settings().adminPasscodeHash === null);

  async unlock(passcode: string, role: Exclude<Role, 'customer'>): Promise<boolean> {
    const stored = this.store.settings().adminPasscodeHash;
    const candidate = await sha256Hex(passcode);
    const expected = stored ?? (await sha256Hex(DEFAULT_PASSCODE));

    if (candidate !== expected) {
      this.failedAttempts.update((n) => n + 1);
      await this.store.logAudit('admin_unlock_failed', { role }, null, 'unknown');
      return false;
    }

    this.failedAttempts.set(0);
    this.currentRole.set(role);
    await this.store.logAudit('admin_unlocked', { role }, null, role);
    return true;
  }

  /** Drop back to the customer-facing view. Always available, no passcode. */
  lock(): void {
    this.currentRole.set('customer');
  }

  async setPasscode(passcode: string): Promise<void> {
    await this.store.saveSettings({ adminPasscodeHash: await sha256Hex(passcode) });
  }
}
