<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { open as openDialog, ask as askDialog } from "@tauri-apps/plugin-dialog";
import {
  KeyRound,
  Plus,
  Pencil,
  Trash2,
  Upload,
  X,
} from "@lucide/vue";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import CardContent from "@/components/ui/CardContent.vue";
import CardHeader from "@/components/ui/CardHeader.vue";
import CardTitle from "@/components/ui/CardTitle.vue";
import Input from "@/components/ui/Input.vue";
import Label from "@/components/ui/Label.vue";
import Badge from "@/components/ui/Badge.vue";
import Select from "@/components/ui/Select.vue";
import Textarea from "@/components/ui/Textarea.vue";
import ScrollArea from "@/components/ui/ScrollArea.vue";
import { useCredentialsStore, isValidEnvKey, type CredentialDraft } from "@/stores/credentials";
import { useToastStore } from "@/stores/toast";
import type { CredentialMode } from "@/lib/tauri";
import {
  parseCredentialImport,
  splitCsvLine,
  type ImportDraft,
} from "@/lib/credential-import";

const creds = useCredentialsStore();
const toast = useToastStore();
const { t } = useI18n();

onMounted(() => creds.ensureHydrated());

// --- Form state ---------------------------------------------------------

const MODE_DEFAULTS: Record<CredentialMode, { envKey: string }> = {
  token: { envKey: "AUTH_TOKEN" },
  basic: { envKey: "AUTH_PASS" },
  apikey: { envKey: "API_KEY" },
  oauth2_client: { envKey: "OAUTH" },
  oauth2_refresh: { envKey: "OAUTH" },
};

const formOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);

const f = reactive({
  name: "",
  mode: "token" as CredentialMode,
  envKey: "AUTH_TOKEN",
  userEnvKey: "AUTH_USER",
  passEnvKey: "AUTH_PASS",
  headerName: "X-API-Key",
  location: "header" as "header" | "query",
  tokenUrl: "",
  scope: "",
  /** token / apikey / oauth2_refresh: one secret per line. */
  valuesText: "",
  /** basic: `user,password` per line; oauth2_client: `client_id,client_secret`. */
  pairsText: "",
  /** oauth2_refresh optional client auth, applied to every refresh token. */
  clientId: "",
  clientSecret: "",
});

const modeOptions = computed(() => [
  { label: t("credentials.modeToken"), value: "token" },
  { label: t("credentials.modeBasic"), value: "basic" },
  { label: t("credentials.modeApikey"), value: "apikey" },
  { label: t("credentials.modeOauth2Client"), value: "oauth2_client" },
  { label: t("credentials.modeOauth2Refresh"), value: "oauth2_refresh" },
]);
const locationOptions = computed(() => [
  { label: t("credentials.locationHeader"), value: "header" },
  { label: t("credentials.locationQuery"), value: "query" },
]);

function resetForm() {
  editingId.value = null;
  f.name = "";
  f.mode = "token";
  f.envKey = MODE_DEFAULTS.token.envKey;
  f.userEnvKey = "AUTH_USER";
  f.passEnvKey = "AUTH_PASS";
  f.headerName = "X-API-Key";
  f.location = "header";
  f.tokenUrl = "";
  f.scope = "";
  f.valuesText = "";
  f.pairsText = "";
  f.clientId = "";
  f.clientSecret = "";
}

function openNew() {
  resetForm();
  formOpen.value = true;
}

function openEdit(id: string) {
  const m = creds.items.find((x) => x.id === id);
  if (!m) return;
  resetForm();
  editingId.value = m.id;
  f.name = m.name;
  f.mode = m.mode;
  f.envKey = m.envKey;
  f.userEnvKey = m.userEnvKey ?? "AUTH_USER";
  f.passEnvKey = m.passEnvKey ?? "AUTH_PASS";
  f.headerName = m.headerName ?? "X-API-Key";
  f.location = m.location ?? "header";
  f.tokenUrl = m.tokenUrl ?? "";
  f.scope = m.scope ?? "";
  // Secret values are never read back from the keychain — the pool stays
  // untouched unless the user types new ones.
  f.valuesText = "";
  f.pairsText = "";
  formOpen.value = true;
}

function onModeChange(mode: string) {
  f.mode = mode as CredentialMode;
  f.envKey = MODE_DEFAULTS[f.mode].envKey;
}

const editingMeta = computed(() =>
  editingId.value ? creds.items.find((m) => m.id === editingId.value) : undefined,
);

/** Parse the secret textareas into the vault's value format per mode.
 *  Returns null plus an i18n error key when the input is invalid. */
function buildValues(): { values: string[]; users?: string[] } | { error: string } {
  const lines = (s: string) =>
    s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  switch (f.mode) {
    case "token":
    case "apikey":
      return { values: lines(f.valuesText) };
    case "basic": {
      const users: string[] = [];
      const passwords: string[] = [];
      for (const line of lines(f.pairsText)) {
        const [u, p] = splitCsvLine(line);
        if (!u || !p) return { error: "credentials.accountsInvalid" };
        users.push(u);
        passwords.push(p);
      }
      return { values: passwords, users };
    }
    case "oauth2_client": {
      const values: string[] = [];
      for (const line of lines(f.pairsText)) {
        const [id, secret] = splitCsvLine(line);
        if (!id || !secret) return { error: "credentials.pairsInvalid" };
        values.push(JSON.stringify({ id, secret }));
      }
      return { values };
    }
    case "oauth2_refresh": {
      const values = lines(f.valuesText).map((r) =>
        JSON.stringify({ refresh: r, id: f.clientId.trim(), secret: f.clientSecret.trim() }),
      );
      return { values };
    }
  }
}

async function submit() {
  if (!f.name.trim()) {
    toast.push({ title: t("credentials.nameRequired"), variant: "warning" });
    return;
  }
  if (!isValidEnvKey(f.envKey.trim())) {
    toast.push({ title: t("credentials.envKeyInvalid"), variant: "warning" });
    return;
  }
  if ((f.mode === "oauth2_client" || f.mode === "oauth2_refresh") && !f.tokenUrl.trim()) {
    toast.push({ title: t("credentials.tokenUrlRequired"), variant: "warning" });
    return;
  }
  const built = buildValues();
  if ("error" in built) {
    toast.push({ title: t(built.error), variant: "warning" });
    return;
  }
  if (built.values.length === 0 && !editingId.value) {
    toast.push({ title: t("credentials.valuesRequired"), variant: "warning" });
    return;
  }
  const draft: CredentialDraft = {
    id: editingId.value ?? undefined,
    name: f.name,
    mode: f.mode,
    envKey: f.envKey,
    userEnvKey: f.userEnvKey,
    passEnvKey: f.passEnvKey,
    headerName: f.headerName,
    location: f.location,
    tokenUrl: f.tokenUrl,
    scope: f.scope,
    users: built.users,
    // Empty on an edit means "keep the stored pool".
    values: built.values.length > 0 ? built.values : null,
  };
  saving.value = true;
  try {
    await creds.saveCredential(draft);
    await creds.flushPersist();
    toast.push({ title: t("credentials.saved"), variant: "success" });
    formOpen.value = false;
  } catch (e) {
    toast.push({
      title: t("credentials.saveFailed"),
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  } finally {
    saving.value = false;
  }
}

async function remove(id: string) {
  const m = creds.items.find((x) => x.id === id);
  if (!m) return;
  const ok = await askDialog(t("credentials.deleteConfirm", { name: m.name }), {
    title: t("credentials.delete"),
    kind: "warning",
    okLabel: t("common.delete"),
    cancelLabel: t("common.cancel"),
  });
  if (!ok) return;
  await creds.removeCredential(id);
  toast.push({ title: t("credentials.deleted"), variant: "info" });
}

// --- Import -------------------------------------------------------------

const importOpen = ref(false);
const importFormat = ref<"auto" | "env" | "json" | "csv">("auto");
const importText = ref("");
const importing = ref(false);

const importPreview = computed<ImportDraft[] | "error" | null>(() => {
  const text = importText.value.trim();
  if (!text) return null;
  try {
    return parseCredentialImport(text, importFormat.value === "auto" ? undefined : importFormat.value);
  } catch {
    return "error";
  }
});

const formatOptions = computed(() => [
  { label: t("credentials.importAuto"), value: "auto" },
  { label: ".env", value: "env" },
  { label: "JSON", value: "json" },
  { label: "CSV", value: "csv" },
]);

async function pickImportFile() {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: "Credentials", extensions: ["env", "txt", "json", "csv"] }],
  });
  if (typeof selected === "string") {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    importText.value = await readTextFile(selected);
  }
}

async function doImport() {
  const preview = importPreview.value;
  if (!preview || preview === "error" || preview.length === 0) return;
  importing.value = true;
  try {
    await creds.importCredentials(preview.map((d) => ({ ...d })));
    toast.push({
      title: t("credentials.imported", { count: preview.length }),
      variant: "success",
    });
    importOpen.value = false;
    importText.value = "";
  } catch (e) {
    toast.push({
      title: t("credentials.importFailed"),
      description: e instanceof Error ? e.message : String(e),
      variant: "destructive",
    });
  } finally {
    importing.value = false;
  }
}

// --- Display helpers ------------------------------------------------------

function modeLabel(mode: string): string {
  const key = `credentials.mode${mode.charAt(0).toUpperCase()}${mode.slice(1).replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}`;
  return t(key);
}

function envSummary(m: { mode: string; envKey: string; userEnvKey?: string; passEnvKey?: string }): string {
  if (m.mode === "basic") return `${m.userEnvKey ?? "AUTH_USER"} / ${m.passEnvKey ?? "AUTH_PASS"}`;
  if (m.mode === "oauth2_client" || m.mode === "oauth2_refresh") return `${m.envKey}_*`;
  return m.envKey;
}
</script>

<template>
  <div class="mx-auto flex h-full max-w-4xl flex-col gap-4 p-4">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h2 class="flex items-center gap-2 text-lg font-semibold">
          <KeyRound class="h-5 w-5 text-primary" /> {{ t("credentials.title") }}
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">{{ t("credentials.description") }}</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" data-testid="cred-import" @click="importOpen = true">
          <Upload class="h-4 w-4" /> {{ t("credentials.import") }}
        </Button>
        <Button size="sm" data-testid="cred-add" @click="openNew">
          <Plus class="h-4 w-4" /> {{ t("credentials.add") }}
        </Button>
      </div>
    </div>

    <ScrollArea class="min-h-0 flex-1">
      <div class="space-y-2 pb-4">
        <Card v-for="m in creds.items" :key="m.id" :data-testid="`cred-item-${m.id}`">
          <CardContent class="flex items-center gap-3 p-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ m.name }}</span>
                <Badge variant="secondary">{{ modeLabel(m.mode) }}</Badge>
                <Badge :variant="m.valueCount > 0 ? 'success' : 'warning'">
                  {{ m.valueCount > 0 ? t("credentials.stored", { count: m.valueCount }) : t("credentials.notSet") }}
                </Badge>
              </div>
              <code class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                {{ envSummary(m) }}
              </code>
            </div>
            <Button variant="ghost" size="icon" :aria-label="t('credentials.edit')" @click="openEdit(m.id)">
              <Pencil class="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" :aria-label="t('credentials.delete')" @click="remove(m.id)">
              <Trash2 class="h-4 w-4 text-destructive" />
            </Button>
          </CardContent>
        </Card>
        <div v-if="!creds.items.length" class="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {{ t("credentials.empty") }}
        </div>
      </div>
    </ScrollArea>

    <!-- Create / edit form -->
    <Card v-if="formOpen" data-testid="cred-form" class="shrink-0">
      <CardHeader class="flex-row items-center justify-between border-b border-border py-2">
        <CardTitle class="text-sm">
          {{ editingId ? t("credentials.edit") : t("credentials.add") }}
        </CardTitle>
        <Button variant="ghost" size="icon" :aria-label="t('common.cancel')" @click="formOpen = false">
          <X class="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent class="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <div>
          <Label class="mb-1 block text-xs">{{ t("credentials.name") }}</Label>
          <Input v-model="f.name" data-testid="cred-name" :placeholder="t('credentials.namePlaceholder')" />
        </div>
        <div>
          <Label class="mb-1 block text-xs">{{ t("credentials.mode") }}</Label>
          <Select
            v-model="f.mode"
            data-testid="cred-mode"
            :options="modeOptions"
            :aria-label="t('credentials.mode')"
            @update:model-value="onModeChange"
          />
        </div>
        <div>
          <Label class="mb-1 block text-xs">
            {{ f.mode === "oauth2_client" || f.mode === "oauth2_refresh"
              ? t("credentials.envKeyPrefix") : t("credentials.envKey") }}
          </Label>
          <Input v-model="f.envKey" data-testid="cred-envkey" class="font-mono" />
          <p class="mt-1 text-xs text-muted-foreground">
            {{ t("credentials.envKeyHint", { name: f.envKey || "AUTH_TOKEN" }) }}
          </p>
        </div>
        <template v-if="f.mode === 'basic'">
          <div>
            <Label class="mb-1 block text-xs">{{ t("credentials.userEnvKey") }}</Label>
            <Input v-model="f.userEnvKey" class="font-mono" />
          </div>
          <div>
            <Label class="mb-1 block text-xs">{{ t("credentials.passEnvKey") }}</Label>
            <Input v-model="f.passEnvKey" class="font-mono" />
          </div>
        </template>
        <template v-if="f.mode === 'apikey'">
          <div>
            <Label class="mb-1 block text-xs">{{ t("credentials.headerName") }}</Label>
            <Input v-model="f.headerName" class="font-mono" />
          </div>
          <div>
            <Label class="mb-1 block text-xs">{{ t("credentials.location") }}</Label>
            <Select v-model="f.location" :options="locationOptions" :aria-label="t('credentials.location')" />
          </div>
        </template>
        <template v-if="f.mode === 'oauth2_client' || f.mode === 'oauth2_refresh'">
          <div class="sm:col-span-2">
            <Label class="mb-1 block text-xs">{{ t("credentials.tokenUrl") }}</Label>
            <Input v-model="f.tokenUrl" placeholder="https://auth.example.com/oauth/token" />
          </div>
          <div v-if="f.mode === 'oauth2_client'">
            <Label class="mb-1 block text-xs">{{ t("credentials.scope") }}</Label>
            <Input v-model="f.scope" placeholder="orders read" />
          </div>
        </template>
        <template v-if="f.mode === 'oauth2_refresh'">
          <div>
            <Label class="mb-1 block text-xs">{{ t("credentials.clientId") }}</Label>
            <Input v-model="f.clientId" />
          </div>
          <div>
            <Label class="mb-1 block text-xs">{{ t("credentials.clientSecret") }}</Label>
            <Input v-model="f.clientSecret" type="password" />
          </div>
        </template>

        <!-- Secret pools -->
        <div v-if="f.mode === 'token' || f.mode === 'apikey'" class="sm:col-span-2">
          <Label class="mb-1 block text-xs">{{ t("credentials.values") }}</Label>
          <Textarea
            v-model="f.valuesText"
            data-testid="cred-values"
            :rows="3"
            class="font-mono text-xs"
            :placeholder="t('credentials.valuesPlaceholder')"
          />
        </div>
        <div v-else-if="f.mode === 'basic'" class="sm:col-span-2">
          <Label class="mb-1 block text-xs">{{ t("credentials.accounts") }}</Label>
          <Textarea
            v-model="f.pairsText"
            data-testid="cred-values"
            :rows="3"
            class="font-mono text-xs"
            :placeholder="t('credentials.accountsPlaceholder')"
          />
        </div>
        <div v-else-if="f.mode === 'oauth2_client'" class="sm:col-span-2">
          <Label class="mb-1 block text-xs">{{ t("credentials.pairs") }}</Label>
          <Textarea
            v-model="f.pairsText"
            data-testid="cred-values"
            :rows="3"
            class="font-mono text-xs"
            :placeholder="t('credentials.pairsPlaceholder')"
          />
        </div>
        <div v-else class="sm:col-span-2">
          <Label class="mb-1 block text-xs">{{ t("credentials.refreshTokens") }}</Label>
          <Textarea
            v-model="f.valuesText"
            data-testid="cred-values"
            :rows="3"
            class="font-mono text-xs"
            :placeholder="t('credentials.valuesPlaceholder')"
          />
        </div>

        <p v-if="editingMeta && editingMeta.valueCount > 0" class="text-xs text-muted-foreground sm:col-span-2">
          {{ t("credentials.valuesUnchanged", { count: editingMeta.valueCount }) }}
        </p>
        <p v-else-if="!editingMeta" class="text-xs text-muted-foreground sm:col-span-2">
          {{ t("credentials.secretNote") }}
        </p>

        <div class="flex gap-2 sm:col-span-2">
          <Button size="sm" data-testid="cred-save" :disabled="saving" @click="submit">
            {{ t("common.save") }}
          </Button>
          <Button size="sm" variant="outline" @click="formOpen = false">
            {{ t("common.cancel") }}
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- Import dialog -->
    <div
      v-if="importOpen"
      class="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      @click.self="importOpen = false"
    >
      <Card class="w-full max-w-xl" data-testid="cred-import-dialog">
        <CardHeader class="flex-row items-center justify-between border-b border-border py-2">
          <CardTitle class="text-sm">{{ t("credentials.importTitle") }}</CardTitle>
          <Button variant="ghost" size="icon" :aria-label="t('common.cancel')" @click="importOpen = false">
            <X class="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent class="space-y-3 p-4">
          <div class="flex items-center gap-2">
            <Select
              v-model="importFormat"
              class="w-40"
              :options="formatOptions"
              :aria-label="t('credentials.importFormat')"
            />
            <Button variant="outline" size="sm" @click="pickImportFile">
              {{ t("credentials.importFile") }}
            </Button>
          </div>
          <Textarea
            v-model="importText"
            data-testid="cred-import-text"
            :rows="8"
            class="font-mono text-xs"
            :placeholder="t('credentials.importPaste')"
          />
          <p v-if="importPreview === 'error'" class="text-xs text-destructive">
            {{ t("credentials.importNothing") }}
          </p>
          <p v-else-if="importPreview && importPreview.length > 0" class="text-xs text-muted-foreground">
            {{ t("credentials.importPreview", { count: importPreview.length }) }}
            —
            {{ importPreview.slice(0, 5).map((d) => d.name).join(", ")
            }}{{ importPreview.length > 5 ? "…" : "" }}
          </p>
          <div class="flex justify-end gap-2">
            <Button variant="outline" size="sm" @click="importOpen = false">
              {{ t("common.cancel") }}
            </Button>
            <Button
              size="sm"
              data-testid="cred-import-confirm"
              :disabled="!importPreview || importPreview === 'error' || importPreview.length === 0 || importing"
              @click="doImport"
            >
              {{ t("credentials.import") }}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
