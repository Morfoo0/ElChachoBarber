/**
 * ec-tabs — lightweight, accessible tab component.
 *
 * Progressive enhancement: without JS all panels render stacked; once the
 * element upgrades (gets [enhanced]) only the selected panel is visible.
 */
class EcTabs extends HTMLElement {
  connectedCallback() {
    this.tabs = Array.from(this.querySelectorAll('[role="tab"]'));
    this.panels = Array.from(this.querySelectorAll('[role="tabpanel"]'));

    this.setAttribute('enhanced', '');

    this.tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => this.select(index));
      tab.addEventListener('keydown', (event) => this.#onKeydown(event, index));
    });

    const initial = this.tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    this.select(initial >= 0 ? initial : 0);
  }

  select(index) {
    this.tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.setAttribute('tabindex', selected ? '0' : '-1');
      if (this.panels[i]) {
        this.panels[i].setAttribute('aria-hidden', selected ? 'false' : 'true');
      }
    });
  }

  #onKeydown(event, index) {
    const count = this.tabs.length;
    let next = index;

    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % count;
        break;
      case 'ArrowLeft':
        next = (index - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.tabs[next].focus();
    this.select(next);
  }
}

if (!customElements.get('ec-tabs')) {
  customElements.define('ec-tabs', EcTabs);
}
