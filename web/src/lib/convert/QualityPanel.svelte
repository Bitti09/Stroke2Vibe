<script lang="ts">
  // Quality rating for every available trace — helps decide what to map to V0/V1.
  import { state as app } from '../appstate.svelte'
  import { rateSources } from './engine'
  import type { SourceRating } from './engine'

  let open = $state(true)
  const ratings = $derived(app.script ? rateSources(app.script, app.generatedAxes) : [])

  const color = (v: SourceRating['verdict']) =>
    v === 'good' ? 'var(--ok)' : v === 'ok' ? '#fbbf24' : 'var(--danger)'

  const barColor = (score: number) =>
    score >= 65 ? 'var(--ok)' : score >= 40 ? '#fbbf24' : 'var(--danger)'
</script>

<div class="panel">
  <h2>
    Trace quality
    <button class="mini" onclick={() => (open = !open)}>{open ? 'hide' : 'show'}</button>
  </h2>
  {#if open}
    <p class="muted">
      How usable is each existing trace as a vibe source? Based on tempo, amplitude range,
      smoothness (square jumps), jitter, density and redundancy vs L0.
    </p>
    {#each ratings as r (r.id)}
      <div class="trace">
        <div class="head">
          <span class="id">{r.id}</span>
          <span class="badge" style="background:{barColor(r.score)}">{r.verdict}</span>
          <div class="scorebar">
            <div style="width:{r.score}%; background:{barColor(r.score)}"></div>
          </div>
          <span class="score">{r.score}</span>
        </div>
        <div class="meta muted">
          {r.actions} actions · {r.spanSec.toFixed(0)}s
          {#if !r.vibeLike}
            · {r.tempoHz > 0 ? `${r.tempoHz.toFixed(2)} Hz` : 'no tempo'} · amp med {r.amplitudeRange.toFixed(1)}
            {#if r.parallelToL0 !== null}· {Math.round(r.parallelToL0 * 100)}% parallel to L0{/if}
          {:else}
            · vibe-like (used directly)
          {/if}
        </div>
        <ul class="notes">
          {#each r.notes as n}
            <li>{n}</li>
          {/each}
        </ul>
        {#if r.recommendations.length > 0}
          <div class="recs">
            <span class="rectitle">Recommendations</span>
            <ul>
              {#each r.recommendations as rec}
                <li>{rec}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0 0 0.5rem 0;
    font-size: 1.05rem;
  }
  .mini {
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
  }
  .trace {
    border-top: 1px solid #2b2b3d;
    padding: 0.55rem 0;
  }
  .head {
    display: grid;
    grid-template-columns: 40px 60px 1fr 34px;
    gap: 0.5rem;
    align-items: center;
  }
  .id {
    font-weight: 700;
    color: var(--accent-2);
  }
  .badge {
    text-align: center;
    border-radius: 6px;
    font-size: 0.72rem;
    padding: 0.12rem 0;
    color: #101018;
    font-weight: 700;
  }
  .scorebar {
    background: var(--panel-2);
    border-radius: 6px;
    height: 10px;
    overflow: hidden;
  }
  .scorebar div {
    height: 100%;
  }
  .score {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .meta {
    margin: 0.25rem 0 0.15rem 0;
  }
  .notes {
    margin: 0;
    padding-left: 1rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .recs {
    margin: 0.4rem 0 0 0;
    background: rgba(124, 92, 255, 0.08);
    border: 1px solid rgba(124, 92, 255, 0.35);
    border-radius: var(--radius);
    padding: 0.45rem 0.6rem;
  }
  .rectitle {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent-2);
    font-weight: 700;
  }
  .recs ul {
    margin: 0.25rem 0 0 0;
    padding-left: 1rem;
    font-size: 0.82rem;
  }
</style>
