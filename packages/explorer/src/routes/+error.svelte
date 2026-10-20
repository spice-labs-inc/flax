<script lang="ts">
  import { page } from "$app/state";
  import { hrefOf } from "$lib/nav.ts";
</script>

<main class="err">
  <h1>{page.status}</h1>
  <p>{page.error?.message ?? "This page does not exist."}</p>
  <p><a href={hrefOf("/map")}>Open the surface map</a></p>
</main>

<style>
  .err {
    padding: 32px 20px;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 19px;
  }
</style>
