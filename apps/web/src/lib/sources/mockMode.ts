/** `?mockRemote=1`: simulated Spotify/Apple players and a fixture Spotify catalog (tests, demos without accounts). */
export const isMockRemote = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockRemote') === '1';
