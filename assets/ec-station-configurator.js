import { formatMoney } from '@theme/money-formatting';
import { CartLinesUpdateEvent } from '@shopify/events';

const MAX_QUANTITY = 99;

/**
 * Configurador "Mi Estación".
 *
 * Mantiene la selección en localStorage (solo IDs de variante y cantidades),
 * resume el pedido en el panel lateral y añade al carrito usando la API AJAX
 * del tema y los eventos estándar de Shopify para refrescar el drawer.
 */
class EcStationConfigurator extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;

    this.initialized = true;
    this.storageKey = this.dataset.storageKey || 'ec-station:v1';
    this.moneyFormat = this.dataset.moneyFormat || '';
    this.currency = this.dataset.currency || 'MXN';
    this.state = new Map();
    this.rows = new Map();
    this.loading = false;
    this.abortController = new AbortController();

    this.summaryTitle = this.querySelector('.ec-config__summary-title');
    this.selectedList = this.querySelector('[data-selected]');
    this.emptyMessage = this.querySelector('[data-empty]');
    this.clearButton = this.querySelector('[data-clear]');
    this.status = this.querySelector('[data-status]');
    this.error = this.querySelector('[data-error]');
    this.bar = this.querySelector('[data-bar]');

    if (this.summaryTitle) this.summaryTitle.setAttribute('tabindex', '-1');

    this.#indexRows();
    this.#bindEvents();
    this.#restore();
    this.#renderSummary();

    document.addEventListener('shopify:section:load', this.#onSectionLoad, {
      signal: this.abortController.signal,
    });
  }

  disconnectedCallback() {
    this.abortController?.abort();
    this.initialized = false;
  }

  #bindEvents() {
    const { signal } = this.abortController;

    this.addEventListener('input', this.#onQtyInput, { signal });
    this.addEventListener('focusout', this.#onQtyBlur, { signal });
    this.addEventListener('click', this.#onClick, { signal });
    window.addEventListener('storage', this.#onStorage, { signal });
  }

  #onSectionLoad = (event) => {
    const target = event.target;

    if (target instanceof Node && (target === this || target.contains(this))) {
      this.abortController.abort();
      this.initialized = false;
      this.connectedCallback();
    }
  };

  #indexRows() {
    this.rows = new Map();

    for (const row of this.querySelectorAll('[data-variant-id]')) {
      const id = row.dataset.variantId;
      const group = this.rows.get(id) ?? [];
      group.push(row);
      this.rows.set(id, group);
    }
  }

  #rowFor(id) {
    return this.rows.get(id)?.[0] ?? null;
  }

  #isAvailable(id) {
    return (this.rows.get(id) ?? []).some((row) => row.dataset.available === 'true');
  }

  #onQtyInput = (event) => {
    const input = event.target.closest('[data-qty]');
    if (!input || input.disabled) return;

    const row = input.closest('[data-variant-id]');
    if (!row) return;

    const id = row.dataset.variantId;
    const raw = input.value;

    if (raw === '') {
      this.state.delete(id);
    } else {
      const quantity = this.#clampQuantity(Number(raw));
      input.value = String(quantity);
      this.#setState(id, quantity);
    }

    this.#syncRows(id);
    this.#clearMessages();
    this.#persist();
    this.#renderSummary();
  };

  #onQtyBlur = (event) => {
    const input = event.target.closest('[data-qty]');
    if (!input) return;

    const row = input.closest('[data-variant-id]');
    if (!row) return;

    const id = row.dataset.variantId;
    const quantity = this.state.get(id) ?? 0;
    input.value = String(quantity);
  };

  #onClick = (event) => {
    const step = event.target.closest('[data-step]');
    if (step) {
      const id = step.dataset.summaryVariant;
      const current = this.state.get(id) ?? 0;
      const next = this.#clampQuantity(current + Number(step.dataset.step));

      this.#setState(id, next);
      this.#syncRows(id);
      this.#clearMessages();
      this.#persist();
      this.#renderSummary({ focusId: id, focusAction: `step-${step.dataset.step}` });
      return;
    }

    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const id = remove.dataset.remove;
      this.#setState(id, 0);
      this.#syncRows(id);
      this.#clearMessages();
      this.#persist();
      this.#renderSummary({ focusAfterRemove: true });
      return;
    }

    const clear = event.target.closest('[data-clear]');
    if (clear) {
      this.state.clear();
      this.#resetInputs();
      this.#clearMessages();
      this.#persist();
      this.#renderSummary();
      this.summaryTitle?.focus();
      return;
    }

    const add = event.target.closest('[data-add]');
    if (add) {
      this.#addToCart();
    }
  };

  #onStorage = (event) => {
    if (event.key !== this.storageKey) return;

    this.state.clear();
    this.#resetInputs();
    this.#restore({ silent: true });
    this.#renderSummary();
  };

  #clampQuantity(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(MAX_QUANTITY, Math.floor(value)));
  }

  #setState(id, quantity) {
    if (quantity > 0) {
      this.state.set(id, quantity);
    } else {
      this.state.delete(id);
    }
  }

  #syncRows(id) {
    const quantity = this.state.get(id) ?? 0;

    for (const row of this.rows.get(id) ?? []) {
      const input = row.querySelector('[data-qty]');
      if (input && input !== document.activeElement) {
        input.value = String(quantity);
      }
    }
  }

  #resetInputs() {
    for (const input of this.querySelectorAll('[data-qty]')) {
      input.value = '0';
    }
  }

  #persist() {
    try {
      if (this.state.size === 0) {
        localStorage.removeItem(this.storageKey);
      } else {
        localStorage.setItem(this.storageKey, JSON.stringify([...this.state]));
      }
    } catch {
      // El configurador sigue funcionando sin persistencia.
    }
  }

  #restore({ silent = false } = {}) {
    let stored;

    try {
      stored = localStorage.getItem(this.storageKey);
    } catch {
      return;
    }

    if (!stored) return;

    let entries;
    try {
      entries = JSON.parse(stored);
    } catch {
      return;
    }

    if (!Array.isArray(entries)) return;

    let restored = 0;
    let dropped = 0;

    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;

      const [rawId, rawQuantity] = entry;
      const id = String(rawId);
      const quantity = this.#clampQuantity(Number(rawQuantity));

      if (quantity <= 0) continue;

      if (!this.rows.has(id) || !this.#isAvailable(id)) {
        dropped += 1;
        continue;
      }

      this.state.set(id, quantity);
      this.#syncRows(id);
      restored += 1;
    }

    if (!silent) {
      if (dropped > 0) {
        this.#setStatus(this.dataset.unavailableMessage || '');
      } else if (restored > 0) {
        this.#setStatus(this.dataset.restoredMessage || '');
      }
    }

    if (dropped > 0 && restored === 0) {
      this.#persist();
    }
  }

  #totalQuantity() {
    let total = 0;
    for (const quantity of this.state.values()) total += quantity;
    return total;
  }

  #subtotal() {
    let subtotal = 0;

    for (const [id, quantity] of this.state) {
      const row = this.#rowFor(id);
      if (!row) continue;
      subtotal += Number(row.dataset.price) * quantity;
    }

    return subtotal;
  }

  #formatMoney(cents) {
    try {
      return formatMoney(cents, this.moneyFormat, this.currency);
    } catch {
      return new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: this.currency,
      }).format(cents / 100);
    }
  }

  #renderSummary({ focusId = null, focusAction = null, focusAfterRemove = false } = {}) {
    const totalQuantity = this.#totalQuantity();
    const subtotal = this.#subtotal();
    const formattedSubtotal = this.#formatMoney(subtotal);

    if (this.selectedList) this.selectedList.replaceChildren();

    if (totalQuantity === 0) {
      if (this.selectedList) this.selectedList.hidden = true;
      if (this.emptyMessage) this.emptyMessage.hidden = false;
    } else {
      if (this.selectedList) this.selectedList.hidden = false;
      if (this.emptyMessage) this.emptyMessage.hidden = true;

      for (const [id, quantity] of this.state) {
        const line = this.#createLine(id, quantity);
        if (line) this.selectedList?.appendChild(line);
      }
    }

    for (const element of this.querySelectorAll('[data-count]')) {
      element.textContent = String(totalQuantity);
    }

    for (const element of this.querySelectorAll('[data-subtotal]')) {
      element.textContent = formattedSubtotal;
    }

    const barCount = this.querySelector('[data-bar-count]');
    if (barCount) {
      barCount.textContent = `${totalQuantity} ${totalQuantity === 1 ? 'artículo' : 'artículos'}`;
    }

    const barSubtotal = this.querySelector('[data-bar-subtotal]');
    if (barSubtotal) barSubtotal.textContent = formattedSubtotal;

    if (this.bar) this.bar.hidden = totalQuantity === 0;
    if (this.clearButton) this.clearButton.hidden = totalQuantity === 0;

    this.#updateAddButtons();

    if (focusId) {
      const target = this.querySelector(
        `[data-summary-variant="${focusId}"][data-action="${focusAction}"]`
      );
      const fallback = this.querySelector('[data-add]:not(:disabled)') ?? this.summaryTitle;
      (target ?? fallback)?.focus();
    } else if (focusAfterRemove) {
      const firstControl = this.querySelector('[data-step], [data-remove]');
      (firstControl ?? this.summaryTitle)?.focus();
    }
  }

  #createLine(id, quantity) {
    const row = this.#rowFor(id);
    if (!row) return null;

    const productTitle = row.dataset.productTitle || '';
    const variantTitle = row.dataset.variantTitle || '';
    const isSingleVariant = (this.rows.get(id)?.length ?? 1) === 1;
    const price = Number(row.dataset.price) * quantity;
    const variantSuffix =
      !isSingleVariant && variantTitle && variantTitle !== 'Default Title' ? ` ${variantTitle}` : '';

    const item = document.createElement('li');
    item.className = 'ec-config__line';

    const info = document.createElement('div');
    info.className = 'ec-config__line-info';

    const title = document.createElement('p');
    title.className = 'ec-config__line-title';
    title.textContent = productTitle;
    info.appendChild(title);

    if (!isSingleVariant && variantTitle && variantTitle !== 'Default Title') {
      const variant = document.createElement('p');
      variant.className = 'ec-config__line-variant';
      variant.textContent = variantTitle;
      info.appendChild(variant);
    }

    const linePrice = document.createElement('p');
    linePrice.className = 'ec-config__line-price';
    linePrice.textContent = this.#formatMoney(price);
    info.appendChild(linePrice);

    const quantityControl = document.createElement('div');
    quantityControl.className = 'ec-config__line-qty';

    const decrement = this.#createStepButton(
      id,
      '-1',
      'Disminuir cantidad',
      '−'
    );
    const value = document.createElement('span');
    value.className = 'ec-config__line-qty-value';
    value.textContent = String(quantity);
    const increment = this.#createStepButton(id, '1', 'Aumentar cantidad', '+');

    quantityControl.append(decrement, value, increment);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ec-config__remove';
    remove.dataset.remove = id;
    remove.setAttribute('aria-label', `Quitar ${productTitle}${variantSuffix} de la estación`);
    remove.textContent = '×';

    item.append(info, quantityControl, remove);
    return item;
  }

  #createStepButton(id, step, label, text) {
    const row = this.#rowFor(id);
    const productTitle = row?.dataset.productTitle || 'producto';
    const variantTitle = row?.dataset.variantTitle;
    const variantSuffix = variantTitle && variantTitle !== 'Default Title' ? ` ${variantTitle}` : '';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ec-config__step';
    button.dataset.step = step;
    button.dataset.summaryVariant = id;
    button.dataset.action = `step-${step}`;
    button.setAttribute('aria-label', `${label} de ${productTitle}${variantSuffix}`);
    button.textContent = text;
    return button;
  }

  #updateAddButtons() {
    const disabled = this.loading || this.state.size === 0;
    const label = this.loading
      ? this.dataset.loadingLabel || 'Añadiendo…'
      : this.dataset.addLabel || 'Añadir al carrito';

    for (const button of this.querySelectorAll('[data-add]')) {
      button.disabled = disabled;
      button.setAttribute('aria-busy', this.loading ? 'true' : 'false');
    }

    for (const element of this.querySelectorAll('[data-add-label]')) {
      element.textContent = label;
    }
  }

  #setStatus(message) {
    if (!this.status) return;
    this.status.textContent = message || '';
  }

  #setError(message) {
    if (!this.error) return;

    if (!message) {
      this.error.hidden = true;
      this.error.textContent = '';
      return;
    }

    this.error.hidden = false;
    this.error.textContent = message;
  }

  #clearMessages() {
    this.#setStatus('');
    this.#setError('');
  }

  async #addToCart() {
    if (this.loading || this.state.size === 0) return;

    const items = [];

    for (const [id, quantity] of this.state) {
      if (!this.#isAvailable(id)) {
        this.#setError(this.dataset.unavailableMessage || '');
        return;
      }

      items.push({ id: Number(id), quantity });
    }

    if (items.length === 0) return;

    const sections = [
      ...new Set(
        [...document.querySelectorAll('cart-items-component')]
          .map((element) => element.dataset.sectionId)
          .filter(Boolean)
      ),
    ];

    const totalQuantity = this.#totalQuantity();
    const deferred = CartLinesUpdateEvent.createPromise();
    const routes = window.Theme?.routes ?? {};

    this.loading = true;
    this.#clearMessages();
    this.#updateAddButtons();
    this.setAttribute('aria-busy', 'true');

    document.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: items.map((item) => ({
          merchandiseId: String(item.id),
          quantity: item.quantity,
        })),
        promise: deferred.promise,
      })
    );

    try {
      const cartBefore = await this.#fetchCart(routes);
      const response = await fetch(routes.cart_add_url || '/cart/add.js', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          items,
          sections: sections.join(','),
        }),
      });

      const data = await response.json().catch(() => ({}));
      const message = this.#addErrorMessage(data);
      const hasError = !response.ok || Boolean(message);

      if (hasError) {
        const cartAfter = await this.#fetchCart(routes);
        const beforeCount = cartBefore?.item_count ?? 0;
        const afterCount = cartAfter?.item_count ?? 0;
        const addedSomething = Boolean(cartBefore) && afterCount > beforeCount;

        if (!addedSomething) {
          throw new Error(message || this.dataset.errorMessage || 'No pudimos añadir los productos.');
        }

        deferred.resolve({
          cart: cartAfter ? CartLinesUpdateEvent.createCartFromAjaxResponse(cartAfter) : undefined,
          detail: {
            items: cartAfter?.items,
            sections: data.sections,
            itemCount: cartAfter?.item_count ?? totalQuantity,
            source: 'ec-station-configurator',
            didError: true,
          },
        });

        this.state.clear();
        this.#resetInputs();
        this.#persist();
        this.#renderSummary();
        this.#setStatus(message);
        this.#openCart(routes);
        return;
      }

      const cart = await this.#fetchCart(routes);

      deferred.resolve({
        cart: cart ? CartLinesUpdateEvent.createCartFromAjaxResponse(cart) : undefined,
        detail: {
          items: cart?.items,
          sections: data.sections,
          itemCount: cart?.item_count ?? totalQuantity,
          source: 'ec-station-configurator',
          didError: false,
        },
      });

      this.state.clear();
      this.#resetInputs();
      this.#persist();
      this.#renderSummary();
      this.#setStatus(this.dataset.successMessage || 'Productos añadidos al carrito.');
      this.#openCart(routes);
    } catch (error) {
      deferred.reject(error);
      this.#setError(error?.message || this.dataset.errorMessage || 'No pudimos añadir los productos.');
    } finally {
      this.loading = false;
      this.setAttribute('aria-busy', 'false');
      this.#updateAddButtons();
    }
  }

  async #fetchCart(routes) {
    try {
      const response = await fetch(`${routes.cart_url || '/cart'}.json`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });

      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  #openCart(routes) {
    window.requestAnimationFrame(() => {
      if (window.Shopify?.actions?.openCart) {
        window.Shopify.actions.openCart();
      } else {
        window.location.href = routes.cart_url || '/cart';
      }
    });
  }

  #addErrorMessage(data) {
    if (!data) return '';
    if (typeof data.description === 'string' && data.description.trim()) return data.description;
    if (typeof data.message === 'string' && data.message.trim()) return data.message;

    if (Array.isArray(data.errors) && data.errors.length > 0) {
      return data.errors.join(' ');
    }

    if (data.errors && typeof data.errors === 'object') {
      return Object.values(data.errors).flat().join(' ');
    }

    return '';
  }
}

if (!customElements.get('ec-station-configurator')) {
  customElements.define('ec-station-configurator', EcStationConfigurator);
}
