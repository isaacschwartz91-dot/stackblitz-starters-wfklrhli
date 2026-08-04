import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { DataService } from '../../core/data.service';
import { LockService } from '../../core/lock.service';

@Component({
  selector: 'app-lock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="page" style="max-width: 380px">
      <div class="card" style="margin-top: 14vh; text-align: center">
        <div
          class="mark"
          aria-hidden="true"
          style="width: 44px; height: 44px; border-radius: 12px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: 1.3rem; margin: 0 auto 0.8rem"
        >
          ▤
        </div>
        <h1 style="font-size: 1.25rem">{{ data.settings().storeName }}</h1>
        <p class="muted small">Enter the store passcode to unlock this device.</p>

        <form (ngSubmit)="submit()" style="margin-top: 0.8rem">
          <input
            #box
            type="password"
            inputmode="numeric"
            autocomplete="current-password"
            aria-label="Store passcode"
            [value]="passcode()"
            (input)="passcode.set(value($event))"
            style="text-align: center; font-size: 1.15rem; letter-spacing: 0.15em"
          />

          @if (error()) {
            <div class="notice danger" style="margin-top: 0.7rem">{{ error() }}</div>
          }

          <button
            type="submit"
            class="primary big"
            style="width: 100%; margin-top: 0.8rem; justify-content: center"
            [disabled]="busy() || passcode() === ''"
          >
            {{ busy() ? 'Checking…' : 'Unlock' }}
          </button>
        </form>

        <p class="small dim" style="margin: 1rem 0 0">
          Forgotten it? There is no way to recover it — the passcode is never stored. Clearing this
          browser's data for the site removes the lock, and the store data on this device with it.
        </p>
      </div>
    </div>
  `,
})
export class LockPage {
  protected readonly data = inject(DataService);
  private readonly lock = inject(LockService);
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');

  protected readonly passcode = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  constructor() {
    setTimeout(() => this.box()?.nativeElement.focus(), 50);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(): Promise<void> {
    if (this.passcode() === '') return;
    this.busy.set(true);
    this.error.set('');
    try {
      const opened = await this.lock.unlock(this.passcode());
      if (!opened) {
        this.error.set('That passcode does not match.');
        this.passcode.set('');
      }
    } finally {
      this.busy.set(false);
    }
  }
}
