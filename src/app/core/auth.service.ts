/**
 * Who is signed in.
 *
 * With Supabase configured this is a real email + password login backed by
 * GoTrue, and the role comes from the `profiles` table. Without it the app
 * runs in single-browser mode: there is nobody else to keep out, so it signs
 * itself in as an admin whose name can be changed in Settings.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import { DataService, messageOf } from './data.service';
import { hasAuth } from './backend';
import type { Role, User } from './models';

const LOCAL_USER_KEY = 'grocery-picker.local-user';

const DEFAULT_LOCAL_USER: User = {
  id: 'local-staff',
  email: '',
  name: 'Store staff',
  role: 'admin',
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly data = inject(DataService);

  readonly user = signal<User | null>(null);
  readonly checking = signal(true);
  readonly error = signal('');

  readonly signedIn = computed(() => this.user() !== null);
  readonly isAdmin = computed(() => this.user()?.role === 'admin');
  /** True when a real login screen is required to use the app. */
  readonly requiresLogin = computed(() => this.data.backendKind === 'supabase');

  async restore(): Promise<void> {
    this.checking.set(true);
    try {
      const backend = this.data.backend;
      if (hasAuth(backend)) {
        this.user.set(await backend.currentUser());
      } else {
        this.user.set(readLocalUser());
      }
    } catch (cause) {
      this.error.set(messageOf(cause));
      this.user.set(null);
    } finally {
      this.checking.set(false);
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    const backend = this.data.backend;
    if (!hasAuth(backend)) throw new Error('This storage mode has no login.');
    this.error.set('');
    this.user.set(await backend.signIn(email, password));
  }

  async signOut(): Promise<void> {
    const backend = this.data.backend;
    if (hasAuth(backend)) await backend.signOut();
    this.user.set(hasAuth(backend) ? null : readLocalUser());
  }

  /** Rename the local operator; ignored when Supabase provides the identity. */
  setLocalUser(name: string, role: Role): void {
    if (this.requiresLogin()) return;
    const user: User = { ...DEFAULT_LOCAL_USER, name: name.trim() || DEFAULT_LOCAL_USER.name, role };
    localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
    this.user.set(user);
  }

  displayName(): string {
    return this.user()?.name ?? 'Staff';
  }
}

function readLocalUser(): User {
  try {
    const raw = localStorage.getItem(LOCAL_USER_KEY);
    if (raw === null) return DEFAULT_LOCAL_USER;
    const parsed = JSON.parse(raw) as Partial<User>;
    return {
      ...DEFAULT_LOCAL_USER,
      name: typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : DEFAULT_LOCAL_USER.name,
      role: parsed.role === 'staff' ? 'staff' : 'admin',
    };
  } catch {
    return DEFAULT_LOCAL_USER;
  }
}
