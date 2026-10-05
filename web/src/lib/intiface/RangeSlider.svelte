<script lang="ts">
  // Dual-thumb min/max range slider (like Intiface Central's), built from two
  // stacked native range inputs with invisible tracks — keyboard accessible.
  interface Props {
    min?: number
    max?: number
    step?: number
    valueMin: number
    valueMax: number
    /** show % labels right of the track */
    labels?: boolean
  }
  let { min = 0, max = 1, step = 0.01, valueMin = $bindable(0), valueMax = $bindable(1), labels = true }: Props = $props()

  let draggingLow = $state(false)
  let draggingHigh = $state(false)

  const pct = (v: number) => `${Math.round(((v - min) / (max - min)) * 100)}`
  const lo = $derived(pct(valueMin))
  const hi = $derived(pct(valueMax))

  function onLow(e: Event) {
    const v = (e.target as HTMLInputElement).valueAsNumber
    if (v > valueMax) {
      // push the other thumb along (Intiface-like behaviour)
      valueMax = v
    }
    valueMin = v
    draggingLow = true
    draggingHigh = false
  }
  function onHigh(e: Event) {
    const v = (e.target as HTMLInputElement).valueAsNumber
    if (v < valueMin) {
      valueMin = v
    }
    valueMax = v
    draggingHigh = true
    draggingLow = false
  }
</script>

<div class="range">
  <div class="track"></div>
  <div class="fill" style="left:{lo}%; width:{Math.max(0, Number(hi) - Number(lo))}%"></div>
  <input
    type="range"
    class="thumb low"
    class:front={draggingLow || valueMin > valueMax - step / 2}
    min={min}
    max={max}
    step={step}
    value={valueMin}
    oninput={onLow}
    aria-label="minimum"
  />
  <input
    type="range"
    class="thumb high"
    class:front={draggingHigh || valueMin <= valueMax - step / 2}
    min={min}
    max={max}
    step={step}
    value={valueMax}
    oninput={onHigh}
    aria-label="maximum"
  />
  {#if labels}
    <span class="lab">{Math.round(valueMin * 100)}%</span>
    <span class="lab hi">{Math.round(valueMax * 100)}%</span>
  {/if}
</div>

<style>
  .range {
    position: relative;
    height: 22px;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }
  .track {
    position: absolute;
    left: 0;
    right: 0;
    height: 4px;
    border-radius: 2px;
    background: var(--panel-2, #2a2a38);
    pointer-events: none;
  }
  .fill {
    position: absolute;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--accent), var(--accent-2));
    pointer-events: none;
  }
  .thumb {
    position: absolute;
    left: 0;
    width: 100%;
    height: 22px;
    margin: 0;
    background: none;
    pointer-events: none;
    -webkit-appearance: none;
    appearance: none;
  }
  .thumb::-webkit-slider-runnable-track {
    background: transparent;
    height: 22px;
  }
  .thumb::-moz-range-track {
    background: transparent;
    height: 22px;
  }
  .thumb::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    pointer-events: auto;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent-2);
    border: 2px solid #101018;
    cursor: grab;
  }
  .thumb::-moz-range-thumb {
    pointer-events: auto;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent-2);
    border: 2px solid #101018;
    cursor: grab;
  }
  .thumb.front {
    z-index: 3;
  }
  .lab {
    position: absolute;
    left: 0;
    transform: translateX(-100%);
    font-size: 0.72rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .lab.hi {
    left: 100%;
    transform: translateX(0.4rem);
  }
</style>
