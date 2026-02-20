/**
 * analytics.js - Client-side view counter using localStorage
 *
 * Since GitHub Pages has no backend, we use localStorage to track views per device.
 * This gives a local-only count (unique views from this browser).
 *
 * For cross-device analytics, the admin can check GitHub Pages traffic stats
 * at: Repo > Insights > Traffic
 *
 * Data structure in localStorage:
 * c4a_views = { "slug-name": { count: 5, lastVisit: "2026-02-20" }, ... }
 * c4a_views_summary = { totalViews: 150, topPosts: [...] }
 */

var PostAnalytics = (function() {
  var STORAGE_KEY = 'c4a_views';

  function _getData() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function _saveData(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* localStorage full or unavailable */ }
  }

  /**
   * Register a view for a post.
   * Returns the new view count for this post.
   * Only counts 1 view per post per day (to avoid inflating on refresh).
   */
  function trackView(postSlug) {
    if (!postSlug) return 0;
    var data = _getData();
    var today = new Date().toISOString().split('T')[0];

    if (!data[postSlug]) {
      data[postSlug] = { count: 0, lastVisit: '' };
    }

    // Only count one view per day per post
    if (data[postSlug].lastVisit !== today) {
      data[postSlug].count++;
      data[postSlug].lastVisit = today;
      _saveData(data);
    }

    return data[postSlug].count;
  }

  /**
   * Get view count for a specific post
   */
  function getViews(postSlug) {
    var data = _getData();
    return (data[postSlug] && data[postSlug].count) || 0;
  }

  /**
   * Get all view data (for admin panel)
   */
  function getAllViews() {
    return _getData();
  }

  /**
   * Get top N most viewed posts
   */
  function getTopPosts(n) {
    n = n || 10;
    var data = _getData();
    return Object.keys(data)
      .map(function(slug) {
        return { slug: slug, count: data[slug].count, lastVisit: data[slug].lastVisit };
      })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, n);
  }

  /**
   * Get total views across all posts
   */
  function getTotalViews() {
    var data = _getData();
    var total = 0;
    Object.keys(data).forEach(function(slug) {
      total += data[slug].count;
    });
    return total;
  }

  /**
   * Format view count for display
   */
  function formatViews(count) {
    if (count === 0) return '';
    if (count === 1) return '1 visita';
    return count + ' visitas';
  }

  return {
    trackView: trackView,
    getViews: getViews,
    getAllViews: getAllViews,
    getTopPosts: getTopPosts,
    getTotalViews: getTotalViews,
    formatViews: formatViews
  };
})();
