import { Injectable, signal } from '@angular/core';

export type ToastTone = 'info' | 'ok' | 'warn' | 'error';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;

  show(text: string, tone: ToastTone = 'info', ms = 3800): void {
    const id = this.nextId++;
    this.toasts.set([...this.toasts(), { id, text, tone }]);
    setTimeout(() => this.dismiss(id), ms);
  }

  ok(text: string): void {
    this.show(text, 'ok');
  }

  warn(text: string): void {
    this.show(text, 'warn', 5000);
  }

  error(text: string): void {
    this.show(text, 'error', 7000);
  }

  dismiss(id: number): void {
    this.toasts.set(this.toasts().filter((toast) => toast.id !== id));
  }
}
