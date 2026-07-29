/**
 * Sign-in (FR-A3, FR-A4).
 *
 * Password or one-time code, because this user base includes people who will
 * not manage a password reliably. There is deliberately no "create account"
 * link: FR-A1 puts account creation in staff hands only.
 */

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiClient } from '../core/api';
import { AppState } from '../core/state';
import { I18nService } from '../core/i18n';

type Mode = 'password' | 'code' | 'reset';

@Component({
  selector: 'app-sign-in',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .wrap {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px 16px;
      }
      .panel {
        width: 100%;
        max-width: 420px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .brand {
        font-family: var(--serif);
        font-size: 24px;
        font-weight: 600;
        letter-spacing: -0.01em;
        text-wrap: balance;
      }
      form {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .alt {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .linkbtn {
        background: none;
        border: 0;
        padding: 8px 0;
        min-height: var(--tap);
        color: var(--spruce);
        font-size: 13.5px;
        font-weight: 600;
        text-decoration: underline;
      }
    `,
  ],
  template: `
    <div class="wrap">
      <div class="panel">
        <div>
          <div class="brand">{{ t()('appName') }}</div>
          <p class="sec-note" style="margin:6px 0 0">{{ t()('signInHint') }}</p>
        </div>

        @if (state.banner(); as message) {
          <div class="note warn" role="status">{{ message }}</div>
        }
        @if (state.errorMessage(); as message) {
          <div class="note bad" role="alert">{{ message }}</div>
        }
        @if (info(); as message) {
          <div class="note" role="status">{{ message }}</div>
        }

        <form class="card" (ngSubmit)="submit()">
          <div class="field">
            <label for="identifier">{{ t()('identifier') }}</label>
            <input
              id="identifier"
              class="input"
              name="identifier"
              type="text"
              autocomplete="username"
              inputmode="email"
              [(ngModel)]="identifier"
              required
            />
          </div>

          @if (mode() === 'password') {
            <div class="field">
              <label for="password">{{ t()('password') }}</label>
              <input
                id="password"
                class="input"
                name="password"
                type="password"
                autocomplete="current-password"
                [(ngModel)]="password"
                required
              />
            </div>
          }

          @if (mode() === 'code' && codeRequested()) {
            <div class="field">
              <label for="code">{{ t()('enterCode') }}</label>
              <input
                id="code"
                class="input num"
                name="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                [(ngModel)]="code"
                required
              />
            </div>
          }

          @if (mode() === 'reset') {
            @if (codeRequested()) {
              <div class="field">
                <label for="resetCode">{{ t()('enterCode') }}</label>
                <input
                  id="resetCode"
                  class="input num"
                  name="resetCode"
                  type="text"
                  inputmode="numeric"
                  maxlength="6"
                  [(ngModel)]="code"
                  required
                />
              </div>
              <div class="field">
                <label for="newPassword">{{ t()('newPassword') }}</label>
                <input
                  id="newPassword"
                  class="input"
                  name="newPassword"
                  type="password"
                  autocomplete="new-password"
                  minlength="10"
                  [(ngModel)]="newPassword"
                  required
                />
              </div>
            }
          }

          <button class="btn wide" type="submit" [disabled]="state.busy() || busy()">
            {{ submitLabel() }}
          </button>

          <div class="alt">
            @if (mode() === 'password') {
              <button class="linkbtn" type="button" (click)="switchTo('code')">
                {{ t()('useCode') }}
              </button>
              <button class="linkbtn" type="button" (click)="switchTo('reset')">
                {{ t()('forgotPassword') }}
              </button>
            } @else {
              <button class="linkbtn" type="button" (click)="switchTo('password')">
                {{ t()('backToSignIn') }}
              </button>
            }
          </div>
        </form>

        <p class="sec-note" style="margin:0">{{ t()('noAccountHelp') }}</p>

        <div role="group" [attr.aria-label]="t()('language')" style="display:flex;gap:8px">
          <button
            class="btn small"
            type="button"
            [class.ghost]="i18n.language() !== 'en'"
            [attr.aria-pressed]="i18n.language() === 'en'"
            (click)="i18n.setLanguage('en')"
          >
            {{ t()('english') }}
          </button>
          <button
            class="btn small"
            type="button"
            [class.ghost]="i18n.language() !== 'es'"
            [attr.aria-pressed]="i18n.language() === 'es'"
            (click)="i18n.setLanguage('es')"
          >
            {{ t()('spanish') }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class SignInComponent {
  protected readonly state = inject(AppState);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(ApiClient);

  protected readonly t = this.i18n.t;
  protected readonly mode = signal<Mode>('password');
  protected readonly codeRequested = signal(false);
  protected readonly info = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected identifier = '';
  protected password = '';
  protected code = '';
  protected newPassword = '';

  protected submitLabel(): string {
    const t = this.t();
    if (this.mode() === 'password') return t('signIn');
    if (this.mode() === 'code') return this.codeRequested() ? t('verifyCode') : t('sendCode');
    return this.codeRequested() ? t('resetPassword') : t('sendCode');
  }

  protected switchTo(mode: Mode): void {
    this.mode.set(mode);
    this.codeRequested.set(false);
    this.info.set(null);
    this.state.errorMessage.set(null);
    this.code = '';
  }

  protected async submit(): Promise<void> {
    const t = this.t();
    this.state.errorMessage.set(null);
    this.info.set(null);

    if (this.mode() === 'password') {
      await this.state.signIn(this.identifier, this.password);
      this.password = '';
      return;
    }

    this.busy.set(true);
    try {
      if (!this.codeRequested()) {
        // The response is identical whether or not the account exists, so
        // this screen cannot be used to discover who is on the program.
        if (this.mode() === 'code') {
          await this.api.requestCode(this.identifier);
          this.info.set(t('codeSent'));
        } else {
          await this.api.requestReset(this.identifier);
          this.info.set(t('resetSent'));
        }
        this.codeRequested.set(true);
        return;
      }

      if (this.mode() === 'code') {
        await this.state.signInWithCode(this.identifier, this.code);
      } else {
        await this.api.resetPassword(this.identifier, this.code, this.newPassword);
        await this.state.signIn(this.identifier, this.newPassword);
      }
      this.code = '';
      this.newPassword = '';
    } catch (error) {
      this.state.errorMessage.set(
        error instanceof Error ? error.message : 'That did not work. Try again.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
