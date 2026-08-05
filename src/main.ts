import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { App } from './app/app';
import { routes } from './app/routes';
import { AuthService } from './app/core/auth.service';
import { DataService } from './app/core/data.service';
import { SheetSyncService } from './app/import/sheet-sync.service';
import { loadRuntimeConfig } from './app/core/runtime-config';

// Deploy-time settings first: the storage backend is chosen from them.
await loadRuntimeConfig();

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

    // Linked spreadsheets are re-read in the background: the app is usable
    // immediately, and refreshes itself a moment later if anything changed.
    const settings = data.settings();
    if (settings.autoSyncOnOpen && settings.linkedSheets.length > 0) {
      void app.injector.get(SheetSyncService).syncAll();
    }
  })
  .catch((error: unknown) => {
    console.error(error);
  });
