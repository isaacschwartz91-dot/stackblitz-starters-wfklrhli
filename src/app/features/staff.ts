/**
 * Staff and admin screens (FR-A1, FR-A4, FR-A6, FR-A7, FR-5, FR-34).
 *
 * Every control here is also enforced server-side. The UI hiding a button is
 * a convenience; the refusal that matters happens behind the request (NFR-3).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiClient, type RecordRow } from '../core/api';
import { AppState } from '../core/state';
import { I18nService } from '../core/i18n';
import { formatCents } from '../../shared/units';
import { DIETARY_TAGS } from '../../shared/types';
import type { Account, DietaryTag, ProgramProfile } from '../../shared/types';

type Tab = 'accounts' | 'records' | 'catalog';

@Component({
  selector: 'app-staff',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .main {
        padding: 20px;
      }
      .tabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--line);
        margin-bottom: 18px;
        overflow-x: auto;
      }
      .tabs button {
        background: none;
        border: 0;
        border-bottom: 2px solid transparent;
        padding: 11px 14px;
        min-height: var(--tap);
        font-size: 13.5px;
        font-weight: 600;
        color: var(--ink-3);
        white-space: nowrap;
      }
      .tabs button[aria-selected='true'] {
        color: var(--ink);
        border-bottom-color: var(--spruce);
      }
      .row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: flex-end;
        margin-bottom: 16px;
      }
      .row .field {
        flex: 0 1 190px;
      }
      .grid-form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 12px;
      }
      .actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tagpick {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tagpick label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 1px solid var(--line-2);
        border-radius: 999px;
        padding: 0 12px;
        min-height: 38px;
        font-size: 12.5px;
      }
      .reject {
        max-height: 260px;
        overflow-y: auto;
      }
    `,
  ],
  template: `
    <div class="main">
      <h1 class="page">{{ tab() === 'records' ? t()('records') : tab() === 'catalog' ? t()('adminCatalog') : t()('customers') }}</h1>

      <nav class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="tab() === 'accounts'"
          (click)="switch('accounts')"
        >
          {{ t()('customers') }}
        </button>
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="tab() === 'records'"
          (click)="switch('records')"
        >
          {{ t()('records') }}
        </button>
        @if (state.isAdmin()) {
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="tab() === 'catalog'"
            (click)="switch('catalog')"
          >
            {{ t()('adminCatalog') }}
          </button>
        }
      </nav>

      @if (message(); as m) {
        <div class="note" role="status" style="margin-bottom:14px">{{ m }}</div>
      }
      @if (state.errorMessage(); as m) {
        <div class="note bad" role="alert" style="margin-bottom:14px">{{ m }}</div>
      }

      <!-- ------------- accounts ------------- -->
      @if (tab() === 'accounts') {
        <button class="btn" type="button" style="margin-bottom:16px" (click)="showNew.set(!showNew())">
          {{ t()('addCustomer') }}
        </button>

        @if (showNew()) {
          <form class="card" style="margin-bottom:18px" (ngSubmit)="createAccount()">
            <h2 class="sec">{{ t()('createAccount') }}</h2>
            <p class="sec-note">{{ t()('noAccountHelp') }}</p>
            <div class="grid-form">
              <div class="field">
                <label for="na-name">{{ t()('displayName') }}</label>
                <input id="na-name" class="input" name="displayName" [(ngModel)]="form.displayName" />
              </div>
              <div class="field">
                <label for="na-email">{{ t()('email') }}</label>
                <input id="na-email" class="input" name="email" type="email" [(ngModel)]="form.email" />
              </div>
              <div class="field">
                <label for="na-phone">{{ t()('phone') }}</label>
                <input id="na-phone" class="input" name="phone" type="tel" [(ngModel)]="form.phone" />
              </div>
              <div class="field">
                <label for="na-pw">{{ t()('temporaryPassword') }}</label>
                <input id="na-pw" class="input" name="password" type="text" minlength="10" [(ngModel)]="form.password" />
                <span class="hint">10+ characters. The customer can change it after signing in.</span>
              </div>
              <div class="field">
                <label for="na-ref">{{ t()('referralId') }}</label>
                <input id="na-ref" class="input" name="referralId" [(ngModel)]="form.referralId" />
              </div>
              <div class="field">
                <label for="na-members">{{ t()('members') }}</label>
                <input id="na-members" class="input num" name="memberCount" type="number" min="1" step="1" [(ngModel)]="form.memberCount" />
              </div>
              <div class="field">
                <label for="na-profile">{{ t()('programProfile') }}</label>
                <select id="na-profile" class="input" name="profileId" [(ngModel)]="form.profileId">
                  @for (p of profiles(); track p.id) {
                    <option [value]="p.id">{{ p.name }} (v{{ p.version }})</option>
                  }
                </select>
              </div>
              <div class="field">
                <label for="na-start">{{ t()('periodStart') }}</label>
                <input id="na-start" class="input" name="periodStart" type="date" [(ngModel)]="form.periodStart" />
              </div>
            </div>

            <div class="field" style="margin-top:12px">
              <span class="label-sm">{{ t()('dietaryRestrictions') }}</span>
              <div class="tagpick">
                @for (tag of tags; track tag) {
                  <label>
                    <input
                      type="checkbox"
                      [checked]="restrictions().includes(tag)"
                      (change)="toggleTag(tag)"
                    />
                    {{ tag }}
                  </label>
                }
              </div>
            </div>

            <div class="actions" style="margin-top:14px">
              <button class="btn" type="submit" [disabled]="busy()">{{ t()('createAccount') }}</button>
              <button class="btn neutral" type="button" (click)="showNew.set(false)">
                {{ t()('cancel') }}
              </button>
            </div>
          </form>
        }

        <div class="scroll-x">
          <table class="data">
            <thead>
              <tr>
                <th>{{ t()('displayName') }}</th>
                <th>{{ t()('email') }}</th>
                <th>{{ t()('status') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (account of customers(); track account.id) {
                <tr>
                  <td>{{ account.displayName || '—' }}</td>
                  <td>{{ account.email || account.phone }}</td>
                  <td>
                    @if (account.status === 'active') {
                      <span class="chip ok">{{ t()('active') }}</span>
                    } @else {
                      <span class="chip short">{{ t()('suspended') }}</span>
                    }
                  </td>
                  <td>
                    <div class="actions">
                      <button class="btn small" type="button" (click)="assist(account)">
                        {{ t()('assist') }}
                      </button>
                      @if (account.status === 'active') {
                        <button class="btn small neutral" type="button" (click)="act(account, 'suspend')">
                          {{ t()('suspend') }}
                        </button>
                      } @else {
                        <button class="btn small neutral" type="button" (click)="act(account, 'reinstate')">
                          {{ t()('reinstate') }}
                        </button>
                      }
                      <button class="btn small neutral" type="button" (click)="act(account, 'unlock')">
                        {{ t()('unlock') }}
                      </button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      <!-- ------------- records (FR-34) ------------- -->
      @if (tab() === 'records') {
        <div class="row">
          <div class="field">
            <label for="r-from">{{ t()('dateFrom') }}</label>
            <input id="r-from" class="input" type="date" [(ngModel)]="search.from" />
          </div>
          <div class="field">
            <label for="r-to">{{ t()('dateTo') }}</label>
            <input id="r-to" class="input" type="date" [(ngModel)]="search.to" />
          </div>
          <div class="field">
            <label for="r-ref">{{ t()('referralId') }}</label>
            <input id="r-ref" class="input" [(ngModel)]="search.referralId" />
          </div>
          <div class="field">
            <label for="r-members">{{ t()('members') }}</label>
            <input id="r-members" class="input num" type="number" min="1" [(ngModel)]="search.memberCount" />
          </div>
          <button class="btn" type="button" (click)="runSearch()">{{ t()('search') }}</button>
          @if (state.isAdmin()) {
            <button class="btn neutral" type="button" (click)="exportRecords()">
              {{ t()('exportCsv') }}
            </button>
          }
        </div>

        @if (records().length === 0) {
          <p class="sec-note">{{ t()('noRecords') }}</p>
        } @else {
          <div class="scroll-x">
            <table class="data">
              <thead>
                <tr>
                  <th>{{ t()('referralId') }}</th>
                  <th class="r">{{ t()('members') }}</th>
                  <th>{{ t()('finalizedOn') }}</th>
                  <th class="r">{{ t()('orderTotal') }}</th>
                  <th class="r">{{ t()('budgetCap') }}</th>
                  <th>{{ t()('status') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of records(); track row.order.id) {
                  <tr>
                    <td class="num">{{ row.referralId }}</td>
                    <td class="r num">{{ row.memberCount }}</td>
                    <td class="num">{{ row.order.finalizedAt?.slice(0, 10) ?? '—' }}</td>
                    <td class="r num">{{ money(row.order.totalCents) }}</td>
                    <td class="r num">{{ money(row.order.rulesSnapshot.capTotalCents) }}</td>
                    <td>
                      @if (row.order.override) {
                        <span class="chip over">{{ t()('overriddenLabel') }}</span>
                      } @else {
                        <span class="chip ok">{{ t()('final') }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }

      <!-- ------------- catalogue (FR-5) ------------- -->
      @if (tab() === 'catalog' && state.isAdmin()) {
        <div class="row">
          <button class="btn neutral" type="button" (click)="exportCatalog()">
            {{ t()('exportCatalog') }}
          </button>
          <label class="btn" for="csv-file">{{ t()('importCsv') }}</label>
          <input
            id="csv-file"
            type="file"
            accept=".csv,text/csv"
            class="sr-only"
            (change)="onCsvChosen($event)"
          />
        </div>

        <!-- Dry run first: nothing is written until the report is accepted -->
        @if (importReport(); as report) {
          <div class="card">
            <h2 class="sec">{{ t()('validationReport') }}</h2>
            <p class="sec-note">
              <b class="num">{{ report.created }}</b> {{ t()('rowsCreated') }} ·
              <b class="num">{{ report.updated }}</b> {{ t()('rowsUpdated') }} ·
              <b class="num">{{ report.rejected.length }}</b> {{ t()('rowsRejected') }}
            </p>

            @if (report.rejected.length > 0) {
              <div class="scroll-x reject">
                <table class="data">
                  <thead>
                    <tr>
                      <th class="r">{{ t()('line') }}</th>
                      <th>{{ t()('reason') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of report.rejected; track r.line) {
                      <tr>
                        <td class="r num">{{ r.line }}</td>
                        <td>{{ r.reason }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }

            <div class="actions" style="margin-top:14px">
              <button
                class="btn"
                type="button"
                [disabled]="report.created + report.updated === 0 || busy()"
                (click)="commitImport()"
              >
                {{ t()('applyImport') }}
              </button>
              <button class="btn neutral" type="button" (click)="importReport.set(null)">
                {{ t()('cancel') }}
              </button>
            </div>
          </div>
        }
      }
    </div>
  `,
})
export class StaffComponent {
  protected readonly state = inject(AppState);
  protected readonly i18n = inject(I18nService);
  private readonly api = inject(ApiClient);

  protected readonly t = this.i18n.t;
  protected readonly money = formatCents;
  protected readonly tags = DIETARY_TAGS;

  protected readonly tab = signal<Tab>('accounts');
  protected readonly accounts = signal<Account[]>([]);
  protected readonly profiles = signal<ProgramProfile[]>([]);
  protected readonly records = signal<RecordRow[]>([]);
  protected readonly message = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly showNew = signal(false);
  protected readonly restrictions = signal<DietaryTag[]>([]);
  protected readonly importReport = signal<{
    created: number;
    updated: number;
    rejected: { line: number; reason: string; raw: string }[];
  } | null>(null);

  private pendingCsv = '';

  protected readonly customers = computed(() =>
    this.accounts().filter((a) => a.role === 'customer'),
  );

  protected form = {
    displayName: '',
    email: '',
    phone: '',
    password: '',
    referralId: '',
    memberCount: 1,
    profileId: '',
    periodStart: new Date().toISOString().slice(0, 10),
  };

  protected search = { from: '', to: '', referralId: '', memberCount: null as number | null };

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.accounts.set(await this.api.accounts());
      if (this.state.isAdmin()) {
        const profiles = await this.api.profiles();
        this.profiles.set(profiles);
        if (!this.form.profileId && profiles[0]) this.form.profileId = profiles[0].id;
      }
    } catch (error) {
      this.state.errorMessage.set(error instanceof Error ? error.message : 'Could not load.');
    }
  }

  protected switch(tab: Tab): void {
    this.tab.set(tab);
    this.message.set(null);
    this.state.errorMessage.set(null);
    if (tab === 'records' && this.records().length === 0) void this.runSearch();
  }

  protected toggleTag(tag: DietaryTag): void {
    this.restrictions.update((list) =>
      list.includes(tag) ? list.filter((t) => t !== tag) : [...list, tag],
    );
  }

  protected async createAccount(): Promise<void> {
    this.busy.set(true);
    this.state.errorMessage.set(null);
    try {
      await this.api.createAccount({
        role: 'customer',
        ...this.form,
        memberCount: Number(this.form.memberCount),
        restrictions: this.restrictions(),
      });
      this.message.set('Account created.');
      this.showNew.set(false);
      this.restrictions.set([]);
      await this.load();
    } catch (error) {
      this.state.errorMessage.set(
        error instanceof Error ? error.message : 'Could not create the account.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async act(
    account: Account,
    action: 'suspend' | 'reinstate' | 'unlock',
  ): Promise<void> {
    try {
      await this.api.accountAction(account.id, action);
      await this.load();
      this.message.set('Done.');
    } catch (error) {
      this.state.errorMessage.set(error instanceof Error ? error.message : 'That did not work.');
    }
  }

  /** FR-A6: from here on, every action is audited to this staff member. */
  protected async assist(account: Account): Promise<void> {
    await this.state.enterAssist(account.id);
  }

  protected async runSearch(): Promise<void> {
    const query: Record<string, string> = { status: 'final' };
    if (this.search.from) query['from'] = this.search.from;
    if (this.search.to) query['to'] = this.search.to;
    if (this.search.referralId) query['referralId'] = this.search.referralId;
    if (this.search.memberCount) query['memberCount'] = String(this.search.memberCount);
    try {
      this.records.set(await this.api.records(query));
    } catch (error) {
      this.state.errorMessage.set(error instanceof Error ? error.message : 'Search failed.');
    }
  }

  protected async exportRecords(): Promise<void> {
    const query: Record<string, string> = { status: 'final' };
    if (this.search.from) query['from'] = this.search.from;
    if (this.search.to) query['to'] = this.search.to;
    this.download(await this.api.exportRecordsCsv(query), 'scn-records.csv');
  }

  protected async exportCatalog(): Promise<void> {
    this.download(await this.api.exportCatalogCsv(), 'scn-catalog.csv');
  }

  protected onCsvChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      this.pendingCsv = String(reader.result ?? '');
      try {
        // Dry run: report first, write only on confirmation.
        this.importReport.set(await this.api.importCatalog(this.pendingCsv, { commit: false }));
      } catch (error) {
        this.state.errorMessage.set(
          error instanceof Error ? error.message : 'That file could not be read.',
        );
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  protected async commitImport(): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.api.importCatalog(this.pendingCsv, { commit: true });
      this.message.set(`Imported ${result.created} new and ${result.updated} updated items.`);
      this.importReport.set(null);
      this.pendingCsv = '';
    } catch (error) {
      this.state.errorMessage.set(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      this.busy.set(false);
    }
  }

  private download(csv: string, filename: string): void {
    // The BOM makes Excel read UTF-8 correctly instead of mangling accents.
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
