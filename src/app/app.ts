import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from './core/auth.service';
import { DataService } from './core/data.service';
import { LockService } from './core/lock.service';
import { Toasts } from './ui/toasts';
import { LoginPage } from './pages/login/login.page';
import { LockPage } from './pages/lock/lock.page';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Toasts, LoginPage, LockPage],
  template: `
    <div class="app-shell">
      @if (data.loading() || auth.checking()) {
        <div class="page">
          <div class="empty">Loading the store…</div>
        </div>
      } @else if (lock.locked()) {
        <app-lock />
      } @else if (needsLogin()) {
        <app-login />
      } @else {
        <header class="topbar no-print">
          <a class="brand" routerLink="/">
            @if (data.settings().logoUrl; as logo) {
              <img class="brand-logo" [src]="logo" alt="" />
            } @else {
              <span class="mark" aria-hidden="true">▤</span>
            }
            <span>{{ data.settings().storeName }}</span>
          </a>

          <nav class="nav">
            <a routerLink="/orders/new" routerLinkActive="active">New order</a>
            <a routerLink="/orders" routerLinkActive="active">Orders</a>
            <a routerLink="/catalog" routerLinkActive="active">Catalog</a>
            <a routerLink="/aisles" routerLinkActive="active">Walking order</a>
            <a routerLink="/customers" routerLinkActive="active">Customers</a>
            <a routerLink="/aliases" routerLinkActive="active">Shorthand</a>
            <a routerLink="/settings" routerLinkActive="active">Settings</a>
          </nav>

          <span class="spacer"></span>

          <span class="chip hide-narrow" [title]="data.backend.describe">
            {{ data.backendKind === 'supabase' ? 'Cloud' : 'This browser' }}
          </span>
          <span class="small muted hide-narrow">{{ auth.displayName() }}</span>
          @if (lock.enabled()) {
            <button type="button" class="ghost small" (click)="lock.lockNow()">Lock</button>
          }
          @if (auth.requiresLogin()) {
            <button type="button" class="ghost small" (click)="signOut()">Sign out</button>
          }
        </header>

        @if (data.error()) {
          <div class="page" style="padding-bottom:0">
            <div class="notice danger">
              <strong>Could not reach storage.</strong> {{ data.error() }}
              <div class="button-row" style="margin-top:.5rem">
                <button type="button" (click)="data.load()">Try again</button>
                <a class="button" routerLink="/settings">Open settings</a>
              </div>
            </div>
          </div>
        }

        <router-outlet />
      }
    </div>

    <app-toasts />
  `,
})
export class App {
  protected readonly data = inject(DataService);
  protected readonly auth = inject(AuthService);
  protected readonly lock = inject(LockService);

  protected readonly needsLogin = computed(() => this.auth.requiresLogin() && !this.auth.signedIn());

  constructor() {
    // The store's accent colour drives the whole palette.
    effect(() => {
      const accent = this.data.settings().accentColor;
      if (accent.trim() !== '') {
        document.documentElement.style.setProperty('--accent', accent);
      }
      document.title = `${this.data.settings().storeName} — Order picking`;
    });
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
  }
}
