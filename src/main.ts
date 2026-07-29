import { bootstrapApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';

import { App } from './app/app';

bootstrapApplication(App, {
  providers: [provideZonelessChangeDetection()],
}).catch((error: unknown) => {
  console.error('Failed to start the application', error);
});
