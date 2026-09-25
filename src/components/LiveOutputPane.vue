<script setup lang="ts">
/**
 * Auto-scrolling terminal output pane.
 *
 * Behavior:
 * - When new lines arrive and the user is at (or near) the bottom, we snap
 *   to the bottom so the latest output is always visible.
 * - When the user scrolls up past a small "near-bottom" threshold, we drop
 *   out of auto-follow so we don't yank them back while they're inspecting
 *   older lines. A "Jump to latest" pill appears in that state.
 * - Clicking "Jump to latest" (or pressing the End key while focused)
 *   resumes auto-follow and snaps to the bottom.
 *
 * The component is intentionally framework-free on the DOM side: it uses
 * a single scrollable <pre>, watches the line count, and applies
 * scrollTop directly. Vue's reactivity handles the rerender; we only
 * touch the DOM in nextTick() to avoid layout thrash.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronsDown } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    lines: string[];
    /** "stdout" — green-on-black, "stderr" — red-on-dark, "plain" — neutral. */
    tone?: "stdout" | "stderr" | "plain";
    placeholder?: string;
    /** Distance from the bottom (px) that still counts as "near bottom". */
    nearBottomPx?: number;
    /** How many trailing lines to actually render. Older lines are
     *  collapsed into a "(N earlier lines)" notice to keep the DOM
     *  size bounded on long runs. */
    renderWindow?: number;
  }>(),
  { tone: "stdout", placeholder: "", nearBottomPx: 32, renderWindow: 500 },
);

const scroller = ref<HTMLPreElement | null>(null);
const autoFollow = ref(true);
// Toggle for the floating "jump to latest" button — shown whenever the user
// has scrolled away from the bottom.
const showJump = ref(false);

// Pixel height of the scroll container at the moment of the last
// scroll event. Used to distinguish "user scrolled away from bottom"
// from "content shrank and the scroll position naturally changed".
let lastKnownScrollHeight = 0;

function distanceFromBottom(): number {
  const el = scroller.value;
  if (!el) return 0;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isNearBottom(): boolean {
  return distanceFromBottom() <= props.nearBottomPx;
}

function scrollToBottom(smooth = false) {
  const el = scroller.value;
  if (!el) return;
  // Prefer scrollTo so we can request a smooth animation in the UI, but
  // fall back to a direct scrollTop assignment when scrollTo is missing
  // (older jsdom, some WebViews, or older Tauri WebView builds).
  if (typeof el.scrollTo === "function") {
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  // If the scrollHeight shrank (e.g. the run list re-rendered without
  // touching our scroll position), don't second-guess the user's intent.
  const heightChanged = el.scrollHeight !== lastKnownScrollHeight;
  lastKnownScrollHeight = el.scrollHeight;

  if (isNearBottom()) {
    // Snapping to bottom: re-arm auto-follow and hide the pill.
    if (!autoFollow.value) autoFollow.value = true;
    showJump.value = false;
    return;
  }
  // Scrolled away — pause auto-follow, but only when the user is the
  // reason for the new scroll position. Pure content-driven height
  // changes (heightChanged while we were already at the bottom) shouldn't
  // suppress auto-follow.
  if (heightChanged && el.scrollTop === 0) return;
  if (autoFollow.value) autoFollow.value = false;
  showJump.value = true;
}

function jumpToLatest() {
  autoFollow.value = true;
  showJump.value = false;
  nextTick(() => scrollToBottom(true));
}

// Whenever a new line arrives, snap to the bottom if the user hadn't
// scrolled away. We compare the length instead of watching the array
// itself so append-only mutations don't recompute on identity.
watch(
  () => props.lines.length,
  async () => {
    await nextTick();
    if (autoFollow.value) {
      scrollToBottom(false);
    } else {
      // Even if we're not auto-following, if the user is still near the
      // bottom, treat them as wanting the tail and re-arm.
      if (isNearBottom()) {
        autoFollow.value = true;
        showJump.value = false;
        scrollToBottom(false);
      }
    }
  },
);

onBeforeUnmount(() => {
  // Nothing to clean up — the DOM node goes with us.
});

// Tone-driven class palette. The pane reads like a terminal in either
// case; the surrounding card supplies padding / borders.
const toneClass = computed(() => {
  switch (props.tone) {
    case "stderr":
      return "bg-red-950/90 text-red-100";
    case "plain":
      return "bg-muted/60 text-foreground";
    case "stdout":
    default:
      return "bg-black/95 text-emerald-100";
  }
});

/**
 * Windowed rendering: only the trailing `renderWindow` lines get a real
 * DOM node. Older lines are summarised into a single overflow banner.
 * `slice(-N)` is O(N) but N is bounded by the cap in `useRunsStore`, so
 * worst case is 2000 element copy on each new chunk — well below the
 * cost of mounting thousands of `<span>` elements into the live tree.
 */
const overflow = computed(() =>
  Math.max(0, props.lines.length - props.renderWindow),
);
const visibleLines = computed(() =>
  props.lines.slice(-props.renderWindow),
);
</script>

<template>
  <div class="relative h-full overflow-hidden">
    <pre
      ref="scroller"
      class="live-output h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed"
      :class="toneClass"
      @scroll.passive="onScroll"
      tabindex="0"
    ><span
      v-if="overflow > 0"
      class="block border-b border-current/10 pb-1 text-current/40"
    >[… {{ overflow }} earlier lines dropped from view (still in buffer) …]</span><span
      v-for="(l, i) in visibleLines"
      :key="overflow + i"
      class="block"
    >{{ l }}</span><span
      v-if="!visibleLines.length && !overflow && placeholder"
      class="block text-current/40"
    >{{ placeholder }}</span></pre>

    <button
      v-if="showJump"
      type="button"
      class="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full border border-border bg-background/90 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm hover:bg-accent"
      @click="jumpToLatest"
    >
      <ChevronsDown class="h-3 w-3" /> Jump to latest
    </button>
  </div>
</template>

<style scoped>
.live-output {
  scrollbar-gutter: stable;
}
.live-output:focus {
  outline: none;
}
</style>