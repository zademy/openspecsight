<template>
  <div class="flex min-h-screen flex-col bg-default text-highlighted">
    <header class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-default px-4 sm:px-6">
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-eye" class="size-5 text-primary" />
        <span class="font-semibold">OpenSpecSight</span>
      </div>

      <UColorModeButton />
    </header>

    <div class="flex flex-1 items-stretch">
      <aside class="hidden w-56 shrink-0 border-r border-default p-4 md:block">
        <!-- Sidebar navigation placeholder: projects and settings land here in later tasks. -->
        <p class="text-xs font-medium uppercase tracking-wide text-muted">Projects</p>
      </aside>

      <main class="flex-1 p-4 sm:p-6">
        <slot />
      </main>
    </div>
  </div>
</template>
