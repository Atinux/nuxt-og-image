<script lang="ts" setup>
import { absoluteBasePath, refreshTime, rpc } from '~/util/logic'

const config = await rpc.useServerConfig()

const height = config.value?.height || 630
const width = config.value?.width || 1200

const aspectRatio = width / height
</script>

<template>
  <ImageLoader
    :src="`${absoluteBasePath}/__og_image__/og.png?timestamp=${refreshTime}`"
    :aspect-ratio="aspectRatio"
    description="[PNG] Generated in %sms using Satori & Resvg."
  />
</template>
