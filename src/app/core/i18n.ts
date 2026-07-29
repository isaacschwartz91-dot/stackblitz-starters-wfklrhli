/**
 * Translations (NFR-10).
 *
 * Every string a customer can see is keyed here in English and Spanish.
 * The dictionary is typed off the English keys, so a missing Spanish string
 * is a compile error rather than an English word leaking onto a customer
 * screen at the counter.
 */

import { Injectable, computed, signal } from '@angular/core';
import type { Language } from '../../shared/types';

const EN = {
  appName: 'SCN Food Order Builder',

  // navigation
  navOrder: 'Order',
  navPlan: 'Meal plan',
  navSetup: 'Household',
  navAdmin: 'Admin',
  navRecords: 'Records',
  language: 'Language',
  english: 'English',
  spanish: 'Español',

  // household setup
  householdSetup: 'Household setup',
  referralId: 'Referral / authorization ID',
  referralIdHelp: 'The ID from the SCN referral. No member names are stored.',
  approvedMembers: 'Approved members',
  programProfile: 'Program profile',
  periodStart: 'Benefit period start',
  dietaryRestrictions: 'Dietary restrictions and allergies',
  dietaryHelp: 'Optional. Items that do not meet these are handled per store policy.',
  startOrder: 'Start order',
  resumeDraft: 'Resume saved order',
  requiredForOrder: 'This order requires',
  perMemberPerDay: 'per member per day',
  daysCovered: 'days covered',
  members: 'members',

  // order building
  buildOrder: 'Build the order',
  searchItems: 'Search items',
  searchPlaceholder: 'Search by name, SKU, or UPC',
  allCategories: 'All categories',
  filterByTag: 'Filter by tag',
  addToOrder: 'Add',
  remove: 'Remove',
  quantity: 'Quantity',
  packages: 'packages',
  inYourOrder: 'In your order',
  emptyOrder: 'No items yet. Add food from the catalog to get started.',
  perPackage: 'per package',
  scanBarcode: 'Scan barcode',
  enterUpc: 'Enter UPC',
  itemNotFound: 'No item matches that code.',

  // compliance panel
  progress: 'Progress',
  required: 'Required',
  inCart: 'In order',
  short: 'Short',
  shortBy: 'Short by',
  met: 'Met',
  exceeded: 'Over the minimum',
  overMaximum: 'Over the maximum',
  needMoreVariety: 'Needs more variety',
  distinctItems: 'different items',
  orderTotal: 'Order total',
  budgetCap: 'Budget cap',
  remaining: 'Remaining',
  overBudget: 'Over budget by',
  servings: 'servings',
  qualifies: 'This order qualifies',
  doesNotQualify: 'This order does not qualify yet',
  whatCounts: 'What counts toward each category',
  showBreakdown: 'Show breakdown',
  hideBreakdown: 'Hide breakdown',
  contributes: 'contributes',

  // suggestions
  suggestions: 'Ways to close the gap',
  suggestionAdd: 'Add',
  suggestionCloses: 'Closes the gap',
  suggestionPartial: 'Closes part of the gap',
  noSuggestions: 'No item in the catalog can close this gap within the remaining budget.',
  overCapHelp: 'Ways to get back under the cap',
  reduceItem: 'Reduce',
  swapItem: 'Swap',
  swapTo: 'for',
  saves: 'saves',
  reduceBy: 'Reduce by',
  stillOver: 'Even after these changes the order is still over by',
  contractProblem: 'The cheapest possible qualifying order costs more than the cap',
  contractProblemHelp:
    'This is a contract shortfall, not a mistake by staff. The cheapest basket that meets every category costs',
  whichExceedsBy: 'which exceeds the cap by',
  categoryUnstockable: 'No active item in the catalog can supply this category',

  // finalize
  finalize: 'Finalize order',
  saveDraft: 'Save draft',
  draftSaved: 'Draft saved',
  cannotFinalize: 'Cannot finalize while the order is short or over the cap.',
  override: 'Staff override',
  overrideReason: 'Reason for override',
  staffInitials: 'Staff initials',
  applyOverride: 'Finalize with override',
  overrideRecorded: 'Override recorded',
  orderFinalized: 'Order finalized',

  // meal plan
  mealPlan: 'Meal plan',
  generatePlan: 'Generate meal plan',
  regenerate: 'Try a different plan',
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  supper: 'Supper',
  day: 'Day',
  planStale: 'The order changed. This plan no longer matches it.',
  planIncomplete: 'Some meals could not be filled',
  mealShort: 'Not enough food for this meal',
  unusedItems: 'Food bought but not used in the plan',
  unusedNonCreditable: 'no servings credited — pantry staple',
  leftover: 'left over',
  entirelyUnused: 'not used at all',
  noPlanYet: 'No meal plan yet.',

  // print / records
  print: 'Print',
  customerSheet: 'Customer sheet',
  complianceSheet: 'Compliance sheet',
  records: 'Past orders',
  searchRecords: 'Search past orders',
  dateFrom: 'From',
  dateTo: 'To',
  exportCsv: 'Export CSV',
  reprint: 'Reprint',
  noRecords: 'No orders match this search.',
  finalizedOn: 'Finalized',
  status: 'Status',

  // misc
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  confirm: 'Confirm',
  offline: 'Offline — your work is saved on this device',
  online: 'Online',
  yes: 'Yes',
  no: 'No',
} as const;

export type TranslationKey = keyof typeof EN;

const ES: Record<TranslationKey, string> = {
  appName: 'Creador de Pedidos de Alimentos SCN',

  navOrder: 'Pedido',
  navPlan: 'Plan de comidas',
  navSetup: 'Hogar',
  navAdmin: 'Administración',
  navRecords: 'Registros',
  language: 'Idioma',
  english: 'English',
  spanish: 'Español',

  householdSetup: 'Configuración del hogar',
  referralId: 'ID de referencia / autorización',
  referralIdHelp: 'El ID de la referencia del SCN. No se guardan nombres de miembros.',
  approvedMembers: 'Miembros aprobados',
  programProfile: 'Perfil del programa',
  periodStart: 'Inicio del período de beneficios',
  dietaryRestrictions: 'Restricciones alimentarias y alergias',
  dietaryHelp: 'Opcional. Los artículos que no cumplan se manejan según la política de la tienda.',
  startOrder: 'Comenzar pedido',
  resumeDraft: 'Reanudar pedido guardado',
  requiredForOrder: 'Este pedido requiere',
  perMemberPerDay: 'por miembro por día',
  daysCovered: 'días cubiertos',
  members: 'miembros',

  buildOrder: 'Arme el pedido',
  searchItems: 'Buscar artículos',
  searchPlaceholder: 'Buscar por nombre, SKU o UPC',
  allCategories: 'Todas las categorías',
  filterByTag: 'Filtrar por etiqueta',
  addToOrder: 'Agregar',
  remove: 'Quitar',
  quantity: 'Cantidad',
  packages: 'paquetes',
  inYourOrder: 'En su pedido',
  emptyOrder: 'Aún no hay artículos. Agregue alimentos del catálogo para comenzar.',
  perPackage: 'por paquete',
  scanBarcode: 'Escanear código de barras',
  enterUpc: 'Ingresar UPC',
  itemNotFound: 'Ningún artículo coincide con ese código.',

  progress: 'Progreso',
  required: 'Requerido',
  inCart: 'En el pedido',
  short: 'Falta',
  shortBy: 'Faltan',
  met: 'Cumplido',
  exceeded: 'Por encima del mínimo',
  overMaximum: 'Por encima del máximo',
  needMoreVariety: 'Necesita más variedad',
  distinctItems: 'artículos diferentes',
  orderTotal: 'Total del pedido',
  budgetCap: 'Límite de presupuesto',
  remaining: 'Restante',
  overBudget: 'Excede el presupuesto por',
  servings: 'porciones',
  qualifies: 'Este pedido califica',
  doesNotQualify: 'Este pedido aún no califica',
  whatCounts: 'Qué cuenta para cada categoría',
  showBreakdown: 'Mostrar desglose',
  hideBreakdown: 'Ocultar desglose',
  contributes: 'aporta',

  suggestions: 'Maneras de cerrar la brecha',
  suggestionAdd: 'Agregar',
  suggestionCloses: 'Cierra la brecha',
  suggestionPartial: 'Cierra parte de la brecha',
  noSuggestions:
    'Ningún artículo del catálogo puede cerrar esta brecha dentro del presupuesto restante.',
  overCapHelp: 'Maneras de volver por debajo del límite',
  reduceItem: 'Reducir',
  swapItem: 'Cambiar',
  swapTo: 'por',
  saves: 'ahorra',
  reduceBy: 'Reducir en',
  stillOver: 'Aun con estos cambios, el pedido sigue excediendo por',
  contractProblem: 'El pedido más barato que califica cuesta más que el límite',
  contractProblemHelp:
    'Esto es una limitación del contrato, no un error del personal. La canasta más barata que cumple con todas las categorías cuesta',
  whichExceedsBy: 'lo cual excede el límite por',
  categoryUnstockable: 'Ningún artículo activo del catálogo puede cubrir esta categoría',

  finalize: 'Finalizar pedido',
  saveDraft: 'Guardar borrador',
  draftSaved: 'Borrador guardado',
  cannotFinalize: 'No se puede finalizar mientras falten porciones o se exceda el límite.',
  override: 'Anulación del personal',
  overrideReason: 'Motivo de la anulación',
  staffInitials: 'Iniciales del personal',
  applyOverride: 'Finalizar con anulación',
  overrideRecorded: 'Anulación registrada',
  orderFinalized: 'Pedido finalizado',

  mealPlan: 'Plan de comidas',
  generatePlan: 'Generar plan de comidas',
  regenerate: 'Probar otro plan',
  breakfast: 'Desayuno',
  lunch: 'Almuerzo',
  supper: 'Cena',
  day: 'Día',
  planStale: 'El pedido cambió. Este plan ya no coincide con él.',
  planIncomplete: 'Algunas comidas no se pudieron completar',
  mealShort: 'No hay suficiente comida para esta comida',
  unusedItems: 'Alimentos comprados pero no usados en el plan',
  unusedNonCreditable: 'no acredita porciones — producto de despensa',
  leftover: 'sobrante',
  entirelyUnused: 'no se usó en absoluto',
  noPlanYet: 'Aún no hay plan de comidas.',

  print: 'Imprimir',
  customerSheet: 'Hoja del cliente',
  complianceSheet: 'Hoja de cumplimiento',
  records: 'Pedidos anteriores',
  searchRecords: 'Buscar pedidos anteriores',
  dateFrom: 'Desde',
  dateTo: 'Hasta',
  exportCsv: 'Exportar CSV',
  reprint: 'Reimprimir',
  noRecords: 'Ningún pedido coincide con esta búsqueda.',
  finalizedOn: 'Finalizado',
  status: 'Estado',

  cancel: 'Cancelar',
  save: 'Guardar',
  close: 'Cerrar',
  confirm: 'Confirmar',
  offline: 'Sin conexión — su trabajo está guardado en este dispositivo',
  online: 'En línea',
  yes: 'Sí',
  no: 'No',
};

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = {
  en: EN,
  es: ES,
};

const STORAGE_KEY = 'scn.language';

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly language = signal<Language>(readStoredLanguage());

  readonly dictionary = computed(() => DICTIONARIES[this.language()]);

  /** Translate a key. Falls back to English rather than showing a raw key. */
  t = (key: TranslationKey): string => this.dictionary()[key] ?? EN[key];

  setLanguage(language: Language): void {
    this.language.set(language);
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Private browsing can refuse localStorage; the app still works.
    }
  }

  /** Locale tag for Intl formatting of dates. */
  readonly locale = computed(() => (this.language() === 'es' ? 'es-US' : 'en-US'));
}

function readStoredLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'es' || stored === 'en') return stored;
    if (typeof navigator !== 'undefined' && navigator.language?.startsWith('es')) return 'es';
  } catch {
    // ignore
  }
  return 'en';
}

/** Meal labels in the active language. */
export function mealLabelKey(meal: string): TranslationKey {
  return meal === 'breakfast' ? 'breakfast' : meal === 'lunch' ? 'lunch' : 'supper';
}
