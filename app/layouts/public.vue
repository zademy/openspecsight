<template>
  <div class="flex min-h-screen flex-col bg-default text-highlighted">
    <!-- The public reader's bare chrome: wordmark header, content column,
         one honest footer line. No app rail, no color-mode toggle — visitors
         here read one note, nothing else. -->
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-default px-4 sm:px-6">
      <UIcon name="i-lucide-eye" class="size-5 text-primary" />
      <span class="font-semibold">OpenSpecSight</span>
    </header>

    <main class="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6">
      <slot />
    </main>

    <footer class="px-4 pb-6 text-sm text-muted sm:px-6">
      <!-- Same-origin root: the reader is already on the app. -->
      <p>
        <a href="/" class="text-primary hover:underline">Published with OpenSpecSight</a>
      </p>
    </footer>
  </div>
</template>
