<script setup lang="ts">
import { computed, onMounted, ref, watch as vueWatch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Plus,
  Save,
  Trash2,
  Play,
  RefreshCw,
  FileCode2,
  FolderOpen,
  Sparkles,
  LayoutTemplate,
} from "lucide-vue-next";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { useToastStore } from "@/stores/toast";
import MonacoEditor from "@/components/MonacoEditor.vue";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import CardHeader from "@/components/ui/CardHeader.vue";
import CardTitle from "@/components/ui/CardTitle.vue";
import CardContent from "@/components/ui/CardContent.vue";
import ScrollArea from "@/components/ui/ScrollArea.vue";
import { formatBytes, relativeTime } from "@/lib/utils";
import { SCRIPT_TEMPLATES } from "@/lib/templates";
import { useAppStore } from "@/stores/app";

const scripts = useScriptsStore();
const app = useAppStore();
const ui = useUiStore();
const toast = useToastStore();
const router = useRouter();
const { t } = useI18n();

/** Resolve the absolute directory to create new scripts in.
 *  Falls back to the Rust-reported scripts_dir (always absolute). */
function scriptsBaseDir(): string {
  const known = app.info?.scripts_dir;
  if (known) return known;
  const fromFiles = scripts.files[0]?.path.split(/[\\/]/).slice(0, -1).join("/");
  return fromFiles ?? "";
}

const activeContent = computed(() => {
  const buf = scripts.buffers.find((b) => b.filePath === scripts.activePath);
  return buf?.content ?? "";
});

const activeBuffer = computed(() =>
  scripts.buffers.find((b) => b.filePath === scripts.activePath) ?? null,
);

async function newScript() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `script-${stamp}.js`;
  const base = scriptsBaseDir();
  const full = base ? `${base}/${name}` : name;
  await scripts.saveAs(full, defaultTemplate(name));
  toast.push({ title: "Created script", description: full, variant: "success" });
}

function defaultTemplate(name: string) {
  return `// ${name}
// A minimal k6 script. Use the AI Generate page to draft one from a description.
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    smoke: {
      executor: "constant-vus",
      vus: 5,
      duration: "10s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export default function () {
  const res = http.get("https://test-api.k6.io/public/crocodiles/");
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
  sleep(1);
}
`;
}

async function openFromDisk() {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "JavaScript", extensions: ["js"] }],
  });
  if (!selected || typeof selected !== "string") return;
  await scripts.open(selected);
  toast.push({ title: "Opened", description: selected, variant: "info" });
}

async function importFromList(path: string) {
  await scripts.open(path);
}

const templatesOpen = ref(false);

async function useTemplate(templateId: string) {
  const tpl = SCRIPT_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `${tpl.id}-${stamp}.js`;
  const base = scriptsBaseDir();
  const full = base ? `${base}/${name}` : name;
  await scripts.saveAs(full, tpl.build(name));
  templatesOpen.value = false;
  toast.push({
    title: `Created from ${t(tpl.nameKey)} template`,
    description: full,
    variant: "success",
  });
}

async function saveActive() {
  if (!scripts.activePath) return;
  await scripts.save(scripts.activePath);
  toast.push({ title: t('ai.savedToast'), variant: "success", timeout: 1500 });
}

async function saveActiveAs() {
  if (!activeBuffer.value) return;
  const target = await saveDialog({
    defaultPath: activeBuffer.value.name,
    filters: [{ name: "JavaScript", extensions: ["js"] }],
  });
  if (!target) return;
  await scripts.saveAs(target, activeBuffer.value.content);
  toast.push({ title: t('ai.savedToast'), description: target, variant: "success" });
}

async function deleteFile(path: string) {
  await scripts.remove(path);
  toast.push({ title: "Deleted", description: path, variant: "warning" });
}

function runActive() {
  if (!scripts.activePath) return;
  router.push({
    path: "/runs",
    query: { script: scripts.activePath },
  });
}

function goToAi() {
  router.push("/ai");
}

function onContentUpdate(value: string) {
  if (!scripts.activePath) return;
  scripts.updateContent(scripts.activePath, value);
}

onMounted(async () => {
  await scripts.refresh();
});

vueWatch(
  () => scripts.activePath,
  () => {},
);
</script>

<template>
  <div class="grid h-full grid-cols-[260px_minmax(0,1fr)]">
    <aside class="flex flex-col border-r border-border bg-card/30">
      <div class="flex items-center justify-between border-b border-border p-3">
          <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('editor.scriptsLabel') }}
        </span>
        <Button variant="ghost" size="icon" @click="scripts.refresh()" aria-label="Refresh">
          <RefreshCw class="h-4 w-4" />
        </Button>
      </div>
      <div class="flex gap-1 border-b border-border p-2">
        <Button size="sm" variant="outline" class="flex-1" @click="newScript">
          <Plus class="h-3 w-3" /> {{ t('editor.btnNew') }}
        </Button>
        <Button size="sm" variant="outline" class="flex-1" @click="openFromDisk">
          <FolderOpen class="h-3 w-3" /> {{ t('editor.btnOpen') }}
        </Button>
      </div>
      <div class="relative border-b border-border p-2">
        <Button
          size="sm"
          variant="outline"
          class="w-full justify-start"
          @click="templatesOpen = !templatesOpen"
        >
          <LayoutTemplate class="h-3 w-3" /> {{ t('editor.btnFromTemplate') }} ▾
          <span class="ml-auto text-xs text-muted-foreground">▾</span>
        </Button>
        <div
          v-if="templatesOpen"
          class="absolute left-2 right-2 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          <button
            v-for="tpl in SCRIPT_TEMPLATES"
            :key="tpl.id"
            class="flex w-full flex-col items-start gap-0.5 rounded px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
            @click="useTemplate(tpl.id)"
          >
            <span class="flex w-full items-center gap-2">
              <span class="font-medium">{{ t(tpl.nameKey) }}</span>
              <span class="ml-auto text-[10px] text-muted-foreground">{{ tpl.tag }}</span>
            </span>
            <span class="text-xs text-muted-foreground">{{ t(tpl.descriptionKey) }}</span>
          </button>
        </div>
      </div>
      <ScrollArea class="flex-1">
        <ul class="space-y-0.5 p-2">
          <li v-for="f in scripts.files" :key="f.path">
            <div
              class="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
              :class="f.path === scripts.activePath ? 'bg-accent' : ''"
            >
              <button
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                @click="importFromList(f.path)"
              >
                <FileCode2 class="h-4 w-4 shrink-0 text-muted-foreground" />
                <span class="min-w-0 truncate">{{ f.name }}</span>
              </button>
              <button
                class="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-destructive group-hover:opacity-100"
                @click="deleteFile(f.path)"
                :aria-label="`Delete ${f.name}`"
              >
                <Trash2 class="h-3 w-3" />
              </button>
            </div>
            <div class="-mt-1 ml-7 text-[10px] text-muted-foreground">
              {{ formatBytes(f.size) }} · {{ relativeTime(f.modified_at) }}
            </div>
          </li>
          <li v-if="!scripts.files.length" class="px-2 py-3 text-xs text-muted-foreground">
            {{ t('editor.noScriptsYet') }}
          </li>
        </ul>
      </ScrollArea>
    </aside>

    <section class="flex min-w-0 flex-col">
      <div
        v-if="scripts.buffers.length"
        class="flex items-center gap-2 border-b border-border bg-card/40 px-3 py-1.5"
      >
        <button
          v-for="b in scripts.buffers"
          :key="b.filePath"
          class="flex items-center gap-2 rounded-md px-3 py-1 text-xs transition-colors"
          :class="
            b.filePath === scripts.activePath
              ? 'bg-background shadow-sm'
              : 'text-muted-foreground hover:bg-accent'
          "
          @click="scripts.setActive(b.filePath)"
        >
          <span>{{ b.name }}</span>
          <span v-if="b.dirty" class="h-1.5 w-1.5 rounded-full bg-primary" />
        </button>
        <div class="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" @click="goToAi">
            <Sparkles class="h-3 w-3" /> {{ t('nav.ai') }}
          </Button>
          <Button variant="outline" size="sm" @click="saveActiveAs" :disabled="!activeBuffer">
            Save as…
          </Button>
          <Button variant="outline" size="sm" @click="saveActive" :disabled="!activeBuffer">
            <Save class="h-3 w-3" /> Save
          </Button>
          <Button size="sm" @click="runActive" :disabled="!activeBuffer">
            <Play class="h-3 w-3" /> Run
          </Button>
        </div>
      </div>

      <div class="relative min-h-0 flex-1">
        <MonacoEditor
          v-if="scripts.activePath || scripts.buffers.length"
          :modelValue="activeContent"
          language="javascript"
          :theme="ui.theme === 'dark' ? 'vs-dark' : 'vs'"
          @update:modelValue="onContentUpdate"
        />
        <div v-else class="grid h-full place-items-center">
          <Card class="max-w-md">
            <CardHeader>
              <CardTitle>{{ t('editor.noScriptOpen') }}</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3 text-sm text-muted-foreground">
              <p>{{ t('editor.createOrOpen') }}</p>
              <div class="flex gap-2">
                <Button @click="newScript"><Plus class="h-4 w-4" /> {{ t('common.newScript') }}</Button>
                <Button variant="outline" @click="goToAi"><Sparkles class="h-4 w-4" /> AI Generate</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  </div>
</template>