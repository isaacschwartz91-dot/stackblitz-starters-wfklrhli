import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '../../core/auth.service';
import { DataService, messageOf } from '../../core/data.service';
import { writeStoredConfig } from '../../core/supabase-backend';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="page" style="max-width: 420px">
      <div class="card" style="margin-top: 12vh">
        <h1>{{ data.settings().storeName }}</h1>
        <p class="muted">Sign in to pick orders.</p>

        <form (ngSubmit)="submit()">
          <label class="field">
            <span>Email</span>
            <input type="email" name="email" [(ngModel)]="email" autocomplete="username" required />
          </label>
          <label class="field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              [(ngModel)]="password"
              autocomplete="current-password"
              required
            />
          </label>

          @if (error()) {
            <div class="notice danger">{{ error() }}</div>
          }

          <button type="submit" class="primary big" style="width: 100%" [disabled]="busy()">
            {{ busy() ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>

        <p class="small dim" style="margin-top: 1rem">
          Signed in staff share the same catalog, shelf layout, customers and learned shorthand.
        </p>
        <button type="button" class="ghost small" (click)="useThisBrowser()">
          Work offline in this browser instead
        </button>
      </div>
    </div>
  `,
})
export class LoginPage {
  protected readonly auth = inject(AuthService);
  protected readonly data = inject(DataService);

  protected email = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected async submit(): Promise<void> {
    if (this.email.trim() === '' || this.password === '') {
      this.error.set('Enter your email and password.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.signIn(this.email.trim(), this.password);
      await this.data.load();
    } catch (cause) {
      this.error.set(messageOf(cause));
    } finally {
      this.busy.set(false);
    }
  }

  /** Escape hatch: drop the cloud config and fall back to local storage. */
  protected async useThisBrowser(): Promise<void> {
    if (!confirm('Disconnect from the cloud database and use this browser only?')) return;
    writeStoredConfig(null);
    location.reload();
  }
}
