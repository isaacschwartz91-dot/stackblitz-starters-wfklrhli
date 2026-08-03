import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/dashboard/dashboard.page').then((m) => m.DashboardPage),
  },
  {
    path: 'orders/new',
    loadComponent: () => import('./pages/order-edit/order-edit.page').then((m) => m.OrderEditPage),
  },
  {
    path: 'orders/:id/edit',
    loadComponent: () => import('./pages/order-edit/order-edit.page').then((m) => m.OrderEditPage),
  },
  {
    path: 'orders/:id/pick',
    loadComponent: () => import('./pages/pick-list/pick-list.page').then((m) => m.PickListPage),
  },
  {
    path: 'orders',
    loadComponent: () => import('./pages/orders/orders.page').then((m) => m.OrdersPage),
  },
  {
    path: 'catalog',
    loadComponent: () => import('./pages/catalog/catalog.page').then((m) => m.CatalogPage),
  },
  {
    path: 'aisles',
    loadComponent: () => import('./pages/aisles/aisles.page').then((m) => m.AislesPage),
  },
  {
    path: 'customers',
    loadComponent: () => import('./pages/customers/customers.page').then((m) => m.CustomersPage),
  },
  {
    path: 'aliases',
    loadComponent: () => import('./pages/aliases/aliases.page').then((m) => m.AliasesPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: '' },
];
