import type { ObjectDirective } from 'vue'

const states = new WeakMap<HTMLElement, { previous: HTMLElement | null; keydown: (event: KeyboardEvent) => void }>()
/** Keep keyboard focus in a visible dialog, then return it to its opener. */
export const vModalFocus: ObjectDirective<HTMLElement> = {
  mounted(element) {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = () => [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter(control => control.getClientRects().length > 0)
    const keydown = (event: KeyboardEvent) => {
      event.stopPropagation()
      if (event.key !== 'Tab') return
      const list = controls(), first = list[0], last = list.at(-1)
      if (!first || !last) { event.preventDefault(); element.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus() }
    }
    element.tabIndex = -1
    states.set(element, { previous, keydown })
    element.addEventListener('keydown', keydown)
    queueMicrotask(() => { if (element.isConnected) (controls()[0] ?? element).focus() })
  },
  unmounted(element) {
    const state = states.get(element)
    element.removeEventListener('keydown', state!.keydown)
    if (state?.previous?.isConnected) state.previous.focus()
    states.delete(element)
  }
}
