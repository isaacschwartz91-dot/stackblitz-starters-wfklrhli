import { Directive, ElementRef, afterRenderEffect, inject, input } from '@angular/core';

/**
 * Sets a `<select>`'s current value, correctly.
 *
 * A plain `[value]` binding on a select whose options come from `@for` silently
 * does nothing: Angular applies the element's own bindings before it builds the
 * child views, so at that moment the select has no option to match and the
 * browser falls back to the first one. The dropdown then shows the wrong thing
 * even though the underlying state is right.
 *
 * Applying the value after render fixes it, whatever renders the options.
 */
@Directive({ selector: 'select[selectValue]' })
export class SelectValue {
  readonly selectValue = input.required<string>();

  private readonly host = inject<ElementRef<HTMLSelectElement>>(ElementRef);

  constructor() {
    afterRenderEffect(() => {
      const wanted = this.selectValue();
      const element = this.host.nativeElement;
      if (element.value !== wanted) element.value = wanted;
    });
  }
}
