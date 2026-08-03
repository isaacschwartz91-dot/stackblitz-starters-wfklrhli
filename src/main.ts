import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { App } from './app/app';
import { routes } from './app/routes';
import { AuthService } from './app/core/auth.service';
import { DataService } from './app/core/data.service';

bootstrapApplication(App, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
  ],
})
  .then(async (app) => {
    // Pull the store into memory before anything asks to match an order.
    const data = app.injector.get(DataService);
    const auth = app.injector.get(AuthService);
    await data.load();
    await auth.restore();
  })
  .catch((error: unknown) => {
    console.error(error);
  });
