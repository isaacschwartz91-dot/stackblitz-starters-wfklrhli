/**
 * Translations (NFR-13, AC-8).
 *
 * Every string a customer can see is keyed here in English and Spanish. The
 * Spanish dictionary is typed as Record<TranslationKey, string>, so a missing
 * translation is a compile error rather than an English word appearing on a
 * customer's screen at the counter.
 */

import { Injectable, computed, signal } from '@angular/core';
import type { Language } from '../../shared/types';

const EN = {
  appName: 'SCN Food Order Builder',

  // --- sign in
  signIn: 'Sign in',
  signInHint: 'Use the email or phone number the store has on file.',
  identifier: 'Email or phone number',
  password: 'Password',
  usePassword: 'Use a password',
  useCode: 'Send me a code instead',
  sendCode: 'Send code',
  codeSent: 'If that account exists, a code has been sent.',
  enterCode: 'Enter the 6-digit code',
  verifyCode: 'Sign in with code',
  forgotPassword: 'Forgot your password?',
  resetSent: 'If that account exists, a reset code has been sent.',
  newPassword: 'New password',
  resetPassword: 'Set new password',
  backToSignIn: 'Back to sign in',
  signOut: 'Sign out',
  noAccountHelp: 'Accounts are created by store staff when a referral arrives.',
  sessionEnded: 'Your session ended. Sign in again to continue.',

  // --- shell
  navOrder: 'Order',
  navPlan: 'Meal plan',
  navHistory: 'My orders',
  navRecords: 'Records',
  navAccounts: 'Customers',
  navAdmin: 'Admin',
  language: 'Language',
  english: 'English',
  spanish: 'Español',
  loading: 'Loading…',
  offline: 'Offline — your work is saved on this device',
  pendingSync: 'Saved here; will sync when the connection returns',
  online: 'Online',
  assisting: 'Assisting',
  endAssist: 'Stop assisting',
  suspendedNotice:
    'This account is suspended. Past orders are still available, but a new order cannot be started.',

  // --- household
  referralId: 'Referral ID',
  members: 'Approved members',
  days: 'Days covered',
  periodStart: 'Benefit period start',
  noHousehold: 'This account has no household on file yet. Store staff can add one.',

  // --- order
  buildOrder: 'Build the order',
  buildOrderHint: 'Add whole packages. The panel updates on every tap.',
  startOrder: 'Start a new order',
  orderJourney: 'Your order journey',
  orderWelcome: 'Build a balanced order, one easy step at a time.',
  orderWelcomeBody:
    'Choose the foods you want. We will keep the servings and your budget on track.',
  chooseFoodStep: 'Choose food',
  checkNeedsStep: 'Check your needs',
  finishOrderStep: 'Review and finish',
  currentStep: 'Current step',
  stepComplete: 'Complete',
  quickStartTitle: 'Start with a balanced basket',
  quickStartText:
    'Add budget-friendly recommendations for every category, then make the order your own.',
  addRecommendedBasket: 'Add recommended basket',
  chooseMyself: 'I will choose items myself',
  shoppingTitle: 'Choose food for your order',
  shoppingHint: 'Search or browse by category. Helpful choices are marked Recommended.',
  recommended: 'Recommended',
  itemsInOrder: 'items in your order',
  packagesInOrder: 'packages',
  viewProgress: 'View progress',
  categoriesMet: 'categories met',
  searchItems: 'Search items',
  searchPlaceholder: 'Search by name, SKU, or UPC',
  allCategories: 'All',
  add: 'Add',
  remove: 'Remove',
  inThisOrder: 'In this order',
  emptyOrder: 'No items yet. Add food from the catalogue to get started.',
  item: 'Item',
  qty: 'Qty',
  servings: 'Servings',
  price: 'Price',
  lineTotal: 'Line',
  perPackage: 'per package',
  useEarly: 'Use early',
  noServings: 'No servings credited',
  scanBarcode: 'Scan barcode',
  enterUpc: 'Enter or scan a UPC',
  itemNotFound: 'No item matches that code.',
  restrictedItem: 'Does not meet',

  // --- compliance
  progress: 'Progress',
  requiredServings: 'Required servings',
  of: 'of',
  met: 'Met',
  shortBy: 'Short by',
  overMinimum: 'Over minimum',
  overMaximum: 'Over maximum',
  needsVariety: 'Needs more variety',
  differentItems: 'different items',
  orderTotal: 'Order total',
  budgetCap: 'Budget cap',
  remaining: 'Remaining',
  overBudgetBy: 'Over budget by',
  qualifies: 'This order qualifies',
  doesNotQualify: 'This order does not qualify yet',
  breakdown: 'What counts toward each category',
  showBreakdown: 'Show breakdown',
  hideBreakdown: 'Hide breakdown',
  contributes: 'contributes',

  // --- suggestions
  closeGap: 'Ways to close the gap',
  closesGap: 'closes the gap',
  closesPartially: 'closes part of the gap',
  noSuggestions: 'No item in the catalogue can close this gap within the remaining budget.',
  getUnderCap: 'Ways to get back under the cap',
  reduce: 'Reduce',
  swapFor: 'Swap for',
  saves: 'saves',
  stillOverBy: 'Even after these changes the order is still over by',
  contractProblem: 'The cheapest qualifying order costs more than the cap',
  contractProblemHelp:
    'This is a contract shortfall, not a mistake by staff. The cheapest basket that meets every category costs',
  exceedsCapBy: 'which exceeds the cap by',
  categoryUnstockable: 'No active item in the catalogue can supply this category',

  // --- finalize
  finalize: 'Finalize order',
  finalizeHint: 'Every category is met and the total is within the cap.',
  cannotFinalize: 'Cannot finalize while a category is short or the order is over the cap.',
  askStaff: 'Ask store staff to review this order.',
  staffOverride: 'Staff override',
  overrideReason: 'Reason for override',
  staffInitials: 'Staff initials',
  finalizeWithOverride: 'Finalize with override',
  orderFinalized: 'Order finalized',
  priceChanged: 'A price changed while this order was open',
  priceWas: 'captured at',
  priceNow: 'now',

  // --- meal plan
  mealPlan: 'Meal plan',
  mealPlanHint: 'Every day of the benefit period, drawn only from what was bought.',
  generatePlan: 'Generate meal plan',
  regenerate: 'Try a different plan',
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  supper: 'Supper',
  day: 'Day',
  planStale: 'The order changed. This plan no longer matches it — generate a new one.',
  planIncomplete: 'Some meals could not be filled',
  mealShort: 'Not enough food for this meal',
  unusedItems: 'Bought but not used in the plan',
  pantryStaple: 'credits no servings — pantry staple',
  leftOver: 'left over',
  notUsedAtAll: 'not used at all',
  noPlanYet: 'No meal plan yet.',

  // --- print and records
  print: 'Print',
  printCustomerSheet: 'Print meal plan',
  printComplianceSheet: 'Print compliance sheet',
  customerSheet: 'Meal plan',
  complianceSheet: 'Compliance sheet',
  myOrders: 'My orders',
  noOrders: 'No orders yet.',
  status: 'Status',
  draft: 'Draft',
  final: 'Final',
  finalizedOn: 'Finalized',
  view: 'View',
  reprint: 'Reprint',
  records: 'Records',
  searchRecords: 'Search past orders',
  dateFrom: 'From',
  dateTo: 'To',
  search: 'Search',
  exportCsv: 'Export CSV',
  noRecords: 'No orders match this search.',
  required: 'Required',
  purchased: 'Purchased',
  result: 'Result',
  short: 'SHORT',
  staffInitialsAndDate: 'Staff initials & date',
  customerSignature: 'Customer signature',
  overriddenLabel: 'Finalized with override',

  // --- staff and admin
  customers: 'Customers',
  addCustomer: 'Add customer',
  createAccount: 'Create account',
  email: 'Email',
  phone: 'Phone',
  displayName: 'Name',
  programProfile: 'Program profile',
  dietaryRestrictions: 'Dietary restrictions',
  suspend: 'Suspend',
  reinstate: 'Reinstate',
  unlock: 'Unlock',
  assist: 'Assist',
  temporaryPassword: 'Temporary password',
  active: 'Active',
  suspended: 'Suspended',
  adminRules: 'Program rules',
  adminCatalog: 'Catalogue',
  importCsv: 'Import CSV',
  exportCatalog: 'Export catalogue',
  validationReport: 'Validation report',
  rowsCreated: 'to create',
  rowsUpdated: 'to update',
  rowsRejected: 'rejected',
  line: 'Line',
  reason: 'Reason',
  applyImport: 'Apply import',
  auditLog: 'Audit log',
  when: 'When',
  who: 'Who',
  action: 'Action',

  // --- misc
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  back: 'Back',
  yes: 'Yes',
  no: 'No',
  skipToPanel: 'Skip to the compliance panel',
} as const;

export type TranslationKey = keyof typeof EN;

const ES: Record<TranslationKey, string> = {
  appName: 'Creador de Pedidos de Alimentos SCN',

  signIn: 'Iniciar sesión',
  signInHint: 'Use el correo electrónico o el teléfono que la tienda tiene registrado.',
  identifier: 'Correo electrónico o teléfono',
  password: 'Contraseña',
  usePassword: 'Usar una contraseña',
  useCode: 'Mejor envíenme un código',
  sendCode: 'Enviar código',
  codeSent: 'Si esa cuenta existe, se ha enviado un código.',
  enterCode: 'Ingrese el código de 6 dígitos',
  verifyCode: 'Iniciar sesión con código',
  forgotPassword: '¿Olvidó su contraseña?',
  resetSent: 'Si esa cuenta existe, se ha enviado un código de restablecimiento.',
  newPassword: 'Nueva contraseña',
  resetPassword: 'Establecer nueva contraseña',
  backToSignIn: 'Volver al inicio de sesión',
  signOut: 'Cerrar sesión',
  noAccountHelp: 'El personal de la tienda crea las cuentas cuando llega una referencia.',
  sessionEnded: 'Su sesión terminó. Inicie sesión de nuevo para continuar.',

  navOrder: 'Pedido',
  navPlan: 'Plan de comidas',
  navHistory: 'Mis pedidos',
  navRecords: 'Registros',
  navAccounts: 'Clientes',
  navAdmin: 'Administración',
  language: 'Idioma',
  english: 'English',
  spanish: 'Español',
  loading: 'Cargando…',
  offline: 'Sin conexión — su trabajo está guardado en este dispositivo',
  pendingSync: 'Guardado aquí; se sincronizará cuando vuelva la conexión',
  online: 'En línea',
  assisting: 'Asistiendo a',
  endAssist: 'Dejar de asistir',
  suspendedNotice:
    'Esta cuenta está suspendida. Los pedidos anteriores siguen disponibles, pero no se puede iniciar un pedido nuevo.',

  referralId: 'ID de referencia',
  members: 'Miembros aprobados',
  days: 'Días cubiertos',
  periodStart: 'Inicio del período de beneficios',
  noHousehold: 'Esta cuenta aún no tiene un hogar registrado. El personal puede agregarlo.',

  buildOrder: 'Arme el pedido',
  buildOrderHint: 'Agregue paquetes enteros. El panel se actualiza con cada toque.',
  startOrder: 'Comenzar un pedido nuevo',
  orderJourney: 'El recorrido de su pedido',
  orderWelcome: 'Arme un pedido equilibrado, paso a paso.',
  orderWelcomeBody:
    'Elija los alimentos que desea. Le ayudaremos a mantener las porciones y el presupuesto en orden.',
  chooseFoodStep: 'Elegir alimentos',
  checkNeedsStep: 'Revisar necesidades',
  finishOrderStep: 'Revisar y finalizar',
  currentStep: 'Paso actual',
  stepComplete: 'Completado',
  quickStartTitle: 'Comience con una canasta equilibrada',
  quickStartText:
    'Agregue recomendaciones económicas para cada categoría y después adapte el pedido a sus preferencias.',
  addRecommendedBasket: 'Agregar canasta recomendada',
  chooseMyself: 'Yo elegiré los artículos',
  shoppingTitle: 'Elija alimentos para su pedido',
  shoppingHint: 'Busque o explore por categoría. Las opciones útiles están marcadas como Recomendadas.',
  recommended: 'Recomendado',
  itemsInOrder: 'artículos en su pedido',
  packagesInOrder: 'paquetes',
  viewProgress: 'Ver progreso',
  categoriesMet: 'categorías cumplidas',
  searchItems: 'Buscar artículos',
  searchPlaceholder: 'Buscar por nombre, SKU o UPC',
  allCategories: 'Todas',
  add: 'Agregar',
  remove: 'Quitar',
  inThisOrder: 'En este pedido',
  emptyOrder: 'Aún no hay artículos. Agregue alimentos del catálogo para comenzar.',
  item: 'Artículo',
  qty: 'Cant.',
  servings: 'Porciones',
  price: 'Precio',
  lineTotal: 'Línea',
  perPackage: 'por paquete',
  useEarly: 'Usar pronto',
  noServings: 'No acredita porciones',
  scanBarcode: 'Escanear código de barras',
  enterUpc: 'Ingrese o escanee un UPC',
  itemNotFound: 'Ningún artículo coincide con ese código.',
  restrictedItem: 'No cumple con',

  progress: 'Progreso',
  requiredServings: 'Porciones requeridas',
  of: 'de',
  met: 'Cumplido',
  shortBy: 'Faltan',
  overMinimum: 'Sobre el mínimo',
  overMaximum: 'Sobre el máximo',
  needsVariety: 'Necesita más variedad',
  differentItems: 'artículos diferentes',
  orderTotal: 'Total del pedido',
  budgetCap: 'Límite de presupuesto',
  remaining: 'Restante',
  overBudgetBy: 'Excede el presupuesto por',
  qualifies: 'Este pedido califica',
  doesNotQualify: 'Este pedido aún no califica',
  breakdown: 'Qué cuenta para cada categoría',
  showBreakdown: 'Mostrar desglose',
  hideBreakdown: 'Ocultar desglose',
  contributes: 'aporta',

  closeGap: 'Maneras de cerrar la brecha',
  closesGap: 'cierra la brecha',
  closesPartially: 'cierra parte de la brecha',
  noSuggestions:
    'Ningún artículo del catálogo puede cerrar esta brecha dentro del presupuesto restante.',
  getUnderCap: 'Maneras de volver por debajo del límite',
  reduce: 'Reducir',
  swapFor: 'Cambiar por',
  saves: 'ahorra',
  stillOverBy: 'Aun con estos cambios, el pedido sigue excediendo por',
  contractProblem: 'El pedido más barato que califica cuesta más que el límite',
  contractProblemHelp:
    'Esto es una limitación del contrato, no un error del personal. La canasta más barata que cumple con todas las categorías cuesta',
  exceedsCapBy: 'lo cual excede el límite por',
  categoryUnstockable: 'Ningún artículo activo del catálogo puede cubrir esta categoría',

  finalize: 'Finalizar pedido',
  finalizeHint: 'Todas las categorías se cumplen y el total está dentro del límite.',
  cannotFinalize: 'No se puede finalizar mientras falten porciones o se exceda el límite.',
  askStaff: 'Pida al personal de la tienda que revise este pedido.',
  staffOverride: 'Anulación del personal',
  overrideReason: 'Motivo de la anulación',
  staffInitials: 'Iniciales del personal',
  finalizeWithOverride: 'Finalizar con anulación',
  orderFinalized: 'Pedido finalizado',
  priceChanged: 'Un precio cambió mientras este pedido estaba abierto',
  priceWas: 'registrado en',
  priceNow: 'ahora',

  mealPlan: 'Plan de comidas',
  mealPlanHint: 'Cada día del período de beneficios, solo con lo que se compró.',
  generatePlan: 'Generar plan de comidas',
  regenerate: 'Probar otro plan',
  breakfast: 'Desayuno',
  lunch: 'Almuerzo',
  supper: 'Cena',
  day: 'Día',
  planStale: 'El pedido cambió. Este plan ya no coincide — genere uno nuevo.',
  planIncomplete: 'Algunas comidas no se pudieron completar',
  mealShort: 'No hay suficiente comida para esta comida',
  unusedItems: 'Comprado pero no usado en el plan',
  pantryStaple: 'no acredita porciones — producto de despensa',
  leftOver: 'sobrante',
  notUsedAtAll: 'no se usó en absoluto',
  noPlanYet: 'Aún no hay plan de comidas.',

  print: 'Imprimir',
  printCustomerSheet: 'Imprimir plan de comidas',
  printComplianceSheet: 'Imprimir hoja de cumplimiento',
  customerSheet: 'Plan de comidas',
  complianceSheet: 'Hoja de cumplimiento',
  myOrders: 'Mis pedidos',
  noOrders: 'Aún no hay pedidos.',
  status: 'Estado',
  draft: 'Borrador',
  final: 'Final',
  finalizedOn: 'Finalizado',
  view: 'Ver',
  reprint: 'Reimprimir',
  records: 'Registros',
  searchRecords: 'Buscar pedidos anteriores',
  dateFrom: 'Desde',
  dateTo: 'Hasta',
  search: 'Buscar',
  exportCsv: 'Exportar CSV',
  noRecords: 'Ningún pedido coincide con esta búsqueda.',
  required: 'Requerido',
  purchased: 'Comprado',
  result: 'Resultado',
  short: 'FALTA',
  staffInitialsAndDate: 'Iniciales del personal y fecha',
  customerSignature: 'Firma del cliente',
  overriddenLabel: 'Finalizado con anulación',

  customers: 'Clientes',
  addCustomer: 'Agregar cliente',
  createAccount: 'Crear cuenta',
  email: 'Correo electrónico',
  phone: 'Teléfono',
  displayName: 'Nombre',
  programProfile: 'Perfil del programa',
  dietaryRestrictions: 'Restricciones alimentarias',
  suspend: 'Suspender',
  reinstate: 'Reactivar',
  unlock: 'Desbloquear',
  assist: 'Asistir',
  temporaryPassword: 'Contraseña temporal',
  active: 'Activa',
  suspended: 'Suspendida',
  adminRules: 'Reglas del programa',
  adminCatalog: 'Catálogo',
  importCsv: 'Importar CSV',
  exportCatalog: 'Exportar catálogo',
  validationReport: 'Informe de validación',
  rowsCreated: 'a crear',
  rowsUpdated: 'a actualizar',
  rowsRejected: 'rechazadas',
  line: 'Línea',
  reason: 'Motivo',
  applyImport: 'Aplicar importación',
  auditLog: 'Registro de auditoría',
  when: 'Cuándo',
  who: 'Quién',
  action: 'Acción',

  cancel: 'Cancelar',
  save: 'Guardar',
  close: 'Cerrar',
  back: 'Volver',
  yes: 'Sí',
  no: 'No',
  skipToPanel: 'Saltar al panel de cumplimiento',
};

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en: EN, es: ES };

const STORAGE_KEY = 'scn.language';

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly language = signal<Language>(readStoredLanguage());
  readonly locale = computed(() => (this.language() === 'es' ? 'es-US' : 'en-US'));

  private readonly dictionary = computed(() => DICTIONARIES[this.language()]);

  /** Falls back to English rather than showing a raw key. */
  readonly t = computed(() => {
    const dict = this.dictionary();
    return (key: TranslationKey): string => dict[key] ?? EN[key];
  });

  setLanguage(language: Language): void {
    this.language.set(language);
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      /* private browsing can refuse localStorage; the app still works */
    }
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  }

  /** Category and item names come from the catalogue, not the dictionary. */
  localized(name: string, nameEs: string): string {
    return this.language() === 'es' && nameEs ? nameEs : name;
  }
}

function readStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'es' || stored === 'en') return stored;
    if (typeof navigator !== 'undefined' && navigator.language?.startsWith('es')) return 'es';
  } catch {
    /* ignore */
  }
  return 'en';
}
