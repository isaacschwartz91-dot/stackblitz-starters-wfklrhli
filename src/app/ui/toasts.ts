import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (toasts.toasts().length > 0) {
      <div class="toasts" role="status" aria-live="polite">
        @for (toast of toasts.toasts(); track toast.id) {
          <div class="toast" [class.error]="toast.tone === 'error'" [class.warn]="toast.tone === 'warn'">
            {{ toast.text }}
          </div>
        }
      </div>
    }
  `,
})
export class Toasts {
  protected readonly toasts = inject(ToastService);
}
