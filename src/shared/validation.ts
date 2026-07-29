/**
 * Entry validation (spec section 5).
 *
 * Rejects bad values at the point of entry rather than letting them reach the
 * compliance engine, where a zero member count would silently produce a
 * zero requirement that every empty order "satisfies".
 */

import type { MealKey, ProgramProfile } from './types';
import { MEAL_KEYS } from './types';
import { BP_SCALE } from './units';

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Section 5: zero or negative member count, days, or cap is rejected. */
export function validateHouseholdInput(input: {
  memberCount: number;
  referralId: string;
  periodStart: string;
  profileId: string;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Number.isInteger(input.memberCount) || input.memberCount <= 0) {
    issues.push({
      field: 'memberCount',
      message: 'Approved members must be a whole number of 1 or more.',
    });
  }
  if (!input.referralId.trim()) {
    issues.push({ field: 'referralId', message: 'A referral or authorization ID is required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart)) {
    issues.push({ field: 'periodStart', message: 'Benefit period start must be a valid date.' });
  }
  if (!input.profileId) {
    issues.push({ field: 'profileId', message: 'Select a program profile.' });
  }
  return issues;
}

/** Section 5 + FR-25: profile rules that must hold before it can be saved. */
export function validateProfile(profile: {
  name: string;
  daysCovered: number;
  capAmountCents: number;
  requirements: { categoryKey: string; servingsPerMemberPerDayUnits: number;
    maxServingsPerMemberPerDayUnits: number | null; minDistinctItems: number | null }[];
  mealSplits: { meal: MealKey; categoryKey: string; fractionBp: number }[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!profile.name.trim()) {
    issues.push({ field: 'name', message: 'Profile name is required.' });
  }
  if (!Number.isInteger(profile.daysCovered) || profile.daysCovered <= 0) {
    issues.push({ field: 'daysCovered', message: 'Days covered must be a whole number of 1 or more.' });
  }
  if (!Number.isInteger(profile.capAmountCents) || profile.capAmountCents <= 0) {
    issues.push({ field: 'capAmountCents', message: 'Cap amount must be greater than zero.' });
  }

  for (const req of profile.requirements) {
    if (!Number.isInteger(req.servingsPerMemberPerDayUnits) || req.servingsPerMemberPerDayUnits < 0) {
      issues.push({
        field: `requirement.${req.categoryKey}`,
        message: 'Required servings cannot be negative.',
      });
    }
    if (
      req.maxServingsPerMemberPerDayUnits !== null &&
      req.maxServingsPerMemberPerDayUnits < req.servingsPerMemberPerDayUnits
    ) {
      issues.push({
        field: `requirement.${req.categoryKey}.max`,
        message: 'Maximum servings cannot be below the required minimum.',
      });
    }
    if (req.minDistinctItems !== null && req.minDistinctItems < 0) {
      issues.push({
        field: `requirement.${req.categoryKey}.variety`,
        message: 'Minimum distinct items cannot be negative.',
      });
    }
  }

  // FR-25: the three meals must account for exactly the daily requirement.
  const byCategory = new Map<string, number>();
  for (const split of profile.mealSplits) {
    byCategory.set(split.categoryKey, (byCategory.get(split.categoryKey) ?? 0) + split.fractionBp);
    if (split.fractionBp < 0) {
      issues.push({
        field: `split.${split.categoryKey}.${split.meal}`,
        message: 'Meal split cannot be negative.',
      });
    }
  }
  for (const req of profile.requirements) {
    if (req.servingsPerMemberPerDayUnits <= 0) continue;
    const sum = byCategory.get(req.categoryKey) ?? 0;
    if (sum !== BP_SCALE) {
      issues.push({
        field: `split.${req.categoryKey}`,
        message: `Meal splits for this category total ${(sum / 100).toFixed(2)}%; they must total 100%.`,
      });
    }
  }
  const knownMeals = new Set<string>(MEAL_KEYS);
  for (const split of profile.mealSplits) {
    if (!knownMeals.has(split.meal)) {
      issues.push({ field: 'split', message: `Unknown meal "${split.meal}".` });
    }
  }

  return issues;
}

/** FR-13: quantities are whole packages. */
export function validateQuantity(qty: number): ValidationIssue[] {
  if (!Number.isInteger(qty) || qty < 0) {
    return [{ field: 'qty', message: 'Quantity must be a whole number of packages.' }];
  }
  return [];
}

/**
 * Section 5: two staff editing the same draft — last write wins, but warn.
 * Returns the warning when the copy being saved was based on an older
 * revision than what is already stored.
 */
export function detectWriteConflict(
  storedRevision: number,
  storedWriterId: string,
  incomingBaseRevision: number,
  incomingWriterId: string,
): { conflict: boolean; message: string | null } {
  if (storedRevision > incomingBaseRevision && storedWriterId !== incomingWriterId) {
    return {
      conflict: true,
      message:
        'This draft was changed on another device while you were editing. Your version has been saved over it.',
    };
  }
  return { conflict: false, message: null };
}

/** Profile edits that change the math need a new version, not an in-place edit. */
export function requiresNewVersion(
  before: Pick<ProgramProfile, 'daysCovered' | 'capAmountCents' | 'capBasis' | 'requirements' | 'mealSplits'>,
  after: Pick<ProgramProfile, 'daysCovered' | 'capAmountCents' | 'capBasis' | 'requirements' | 'mealSplits'>,
): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}
