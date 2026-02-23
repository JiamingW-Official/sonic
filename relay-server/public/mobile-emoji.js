/**
 * Sonic Mobile — Win95 Pixel Emoji Stickers
 * 8 animated pixel-art emojis, displayed as fullscreen overlay on desktop.
 */
(function () {
  'use strict';

  // ── 16×16 Pixel Emoji Data (1-bit style, Win95 palette) ──
  // Each emoji: { name, label, color, pixels (16x16 string art), anim }
  var EMOJIS = [
    {
      id: 'heart',
      label: '♥',
      title: 'Love',
      bg: '#ff0000',
      // Pixel heart - classic
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          '<rect x="2" y="3" width="2" height="2" fill="#ff0000"/>' +
          '<rect x="4" y="2" width="2" height="2" fill="#ff0000"/>' +
          '<rect x="6" y="3" width="2" height="2" fill="#ff0000"/>' +
          '<rect x="8" y="2" width="2" height="2" fill="#ff0000"/>' +
          '<rect x="10" y="3" width="2" height="2" fill="#ff0000"/>' +
          '<rect x="12" y="3" width="2" height="2" fill="#ff0000"/>' +
          '<rect x="2" y="5" width="12" height="2" fill="#ff0000"/>' +
          '<rect x="3" y="7" width="10" height="2" fill="#ff0000"/>' +
          '<rect x="4" y="9" width="8" height="2" fill="#ff0000"/>' +
          '<rect x="5" y="11" width="6" height="2" fill="#ff0000"/>' +
          '<rect x="6" y="13" width="4" height="1" fill="#ff0000"/>' +
          '<rect x="7" y="14" width="2" height="1" fill="#ff0000"/>' +
          // Shine
          '<rect x="4" y="3" width="1" height="1" fill="#ff8080"/>' +
          '<rect x="4" y="4" width="1" height="1" fill="#ff8080"/>' +
          '</svg>';
      }
    },
    {
      id: 'happy',
      label: ':D',
      title: 'Happy',
      bg: '#ffff00',
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          // Face circle
          '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
          '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
          '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
          '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
          '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
          '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
          '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
          // Fill yellow
          '<rect x="4" y="2" width="8" height="1" fill="#ffff00"/>' +
          '<rect x="3" y="3" width="10" height="2" fill="#ffff00"/>' +
          '<rect x="2" y="5" width="12" height="6" fill="#ffff00"/>' +
          '<rect x="3" y="11" width="10" height="2" fill="#ffff00"/>' +
          '<rect x="4" y="13" width="8" height="1" fill="#ffff00"/>' +
          // Eyes
          '<rect x="5" y="5" width="2" height="2" fill="#000"/>' +
          '<rect x="9" y="5" width="2" height="2" fill="#000"/>' +
          // Big smile
          '<rect x="4" y="9" width="1" height="1" fill="#000"/>' +
          '<rect x="5" y="10" width="6" height="1" fill="#000"/>' +
          '<rect x="11" y="9" width="1" height="1" fill="#000"/>' +
          '</svg>';
      }
    },
    {
      id: 'cry',
      label: 'T_T',
      title: 'Crying',
      bg: '#4040ff',
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          // Face
          '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
          '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
          '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
          '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
          '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
          '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
          '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
          // Fill
          '<rect x="4" y="2" width="8" height="1" fill="#ffff00"/>' +
          '<rect x="3" y="3" width="10" height="2" fill="#ffff00"/>' +
          '<rect x="2" y="5" width="12" height="6" fill="#ffff00"/>' +
          '<rect x="3" y="11" width="10" height="2" fill="#ffff00"/>' +
          '<rect x="4" y="13" width="8" height="1" fill="#ffff00"/>' +
          // Sad eyes (lines)
          '<rect x="4" y="5" width="3" height="1" fill="#000"/>' +
          '<rect x="9" y="5" width="3" height="1" fill="#000"/>' +
          // Tears
          '<rect x="4" y="7" width="1" height="3" fill="#4040ff"/>' +
          '<rect x="11" y="7" width="1" height="3" fill="#4040ff"/>' +
          '<rect x="4" y="10" width="1" height="2" fill="#6060ff"/>' +
          '<rect x="11" y="10" width="1" height="2" fill="#6060ff"/>' +
          // Frown
          '<rect x="5" y="11" width="1" height="1" fill="#000"/>' +
          '<rect x="6" y="10" width="4" height="1" fill="#000"/>' +
          '<rect x="10" y="11" width="1" height="1" fill="#000"/>' +
          '</svg>';
      }
    },
    {
      id: 'skull',
      label: 'X_X',
      title: 'Dead',
      bg: '#808080',
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          // Skull outline
          '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
          '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
          '<rect x="2" y="3" width="1" height="8" fill="#000"/><rect x="13" y="3" width="1" height="8" fill="#000"/>' +
          '<rect x="3" y="11" width="1" height="1" fill="#000"/><rect x="12" y="11" width="1" height="1" fill="#000"/>' +
          '<rect x="4" y="12" width="8" height="1" fill="#000"/>' +
          // Fill white
          '<rect x="4" y="2" width="8" height="1" fill="#fff"/>' +
          '<rect x="3" y="3" width="10" height="8" fill="#fff"/>' +
          '<rect x="4" y="11" width="8" height="1" fill="#fff"/>' +
          // X eyes
          '<rect x="4" y="4" width="1" height="1" fill="#000"/><rect x="6" y="4" width="1" height="1" fill="#000"/>' +
          '<rect x="5" y="5" width="1" height="1" fill="#000"/>' +
          '<rect x="4" y="6" width="1" height="1" fill="#000"/><rect x="6" y="6" width="1" height="1" fill="#000"/>' +
          '<rect x="9" y="4" width="1" height="1" fill="#000"/><rect x="11" y="4" width="1" height="1" fill="#000"/>' +
          '<rect x="10" y="5" width="1" height="1" fill="#000"/>' +
          '<rect x="9" y="6" width="1" height="1" fill="#000"/><rect x="11" y="6" width="1" height="1" fill="#000"/>' +
          // Teeth
          '<rect x="5" y="9" width="6" height="1" fill="#000"/>' +
          '<rect x="5" y="10" width="1" height="1" fill="#000"/><rect x="7" y="10" width="1" height="1" fill="#000"/>' +
          '<rect x="9" y="10" width="1" height="1" fill="#000"/><rect x="11" y="10" width="0" height="1" fill="#000"/>' +
          '</svg>';
      }
    },
    {
      id: 'fire',
      label: '~*~',
      title: 'Fire',
      bg: '#ff8000',
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          // Outer flame (orange)
          '<rect x="7" y="1" width="2" height="1" fill="#ff6000"/>' +
          '<rect x="6" y="2" width="3" height="1" fill="#ff6000"/>' +
          '<rect x="6" y="3" width="4" height="1" fill="#ff8000"/>' +
          '<rect x="5" y="4" width="5" height="1" fill="#ff8000"/>' +
          '<rect x="4" y="5" width="7" height="1" fill="#ff6000"/>' +
          '<rect x="4" y="6" width="8" height="1" fill="#ff8000"/>' +
          '<rect x="3" y="7" width="9" height="1" fill="#ff6000"/>' +
          '<rect x="3" y="8" width="10" height="1" fill="#ff8000"/>' +
          '<rect x="3" y="9" width="10" height="1" fill="#ff6000"/>' +
          '<rect x="3" y="10" width="10" height="1" fill="#ff4000"/>' +
          '<rect x="4" y="11" width="9" height="1" fill="#ff4000"/>' +
          '<rect x="4" y="12" width="8" height="1" fill="#ff2000"/>' +
          '<rect x="5" y="13" width="6" height="1" fill="#ff2000"/>' +
          '<rect x="6" y="14" width="4" height="1" fill="#c00000"/>' +
          // Inner flame (yellow)
          '<rect x="7" y="5" width="2" height="1" fill="#ffff00"/>' +
          '<rect x="6" y="6" width="3" height="1" fill="#ffff00"/>' +
          '<rect x="6" y="7" width="4" height="1" fill="#ffff00"/>' +
          '<rect x="6" y="8" width="4" height="1" fill="#ffff80"/>' +
          '<rect x="6" y="9" width="4" height="1" fill="#ffff00"/>' +
          '<rect x="7" y="10" width="3" height="1" fill="#ffff00"/>' +
          '<rect x="7" y="11" width="2" height="1" fill="#ffff00"/>' +
          '</svg>';
      }
    },
    {
      id: 'cool',
      label: 'B)',
      title: 'Cool',
      bg: '#000080',
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          // Face
          '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
          '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
          '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
          '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
          '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
          '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
          '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
          // Fill
          '<rect x="4" y="2" width="8" height="1" fill="#ffff00"/>' +
          '<rect x="3" y="3" width="10" height="2" fill="#ffff00"/>' +
          '<rect x="2" y="5" width="12" height="6" fill="#ffff00"/>' +
          '<rect x="3" y="11" width="10" height="2" fill="#ffff00"/>' +
          '<rect x="4" y="13" width="8" height="1" fill="#ffff00"/>' +
          // Sunglasses
          '<rect x="3" y="5" width="4" height="2" fill="#000"/>' +
          '<rect x="9" y="5" width="4" height="2" fill="#000"/>' +
          '<rect x="7" y="5" width="2" height="1" fill="#000"/>' +
          '<rect x="2" y="5" width="1" height="1" fill="#000"/>' +
          '<rect x="13" y="5" width="1" height="1" fill="#000"/>' +
          // Lens shine
          '<rect x="4" y="5" width="1" height="1" fill="#404080"/>' +
          '<rect x="10" y="5" width="1" height="1" fill="#404080"/>' +
          // Smirk
          '<rect x="5" y="10" width="5" height="1" fill="#000"/>' +
          '<rect x="10" y="9" width="1" height="1" fill="#000"/>' +
          '</svg>';
      }
    },
    {
      id: 'star',
      label: '★',
      title: 'Star',
      bg: '#ffcc00',
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          // Star shape
          '<rect x="7" y="1" width="2" height="2" fill="#ffcc00"/>' +
          '<rect x="6" y="3" width="4" height="1" fill="#ffcc00"/>' +
          '<rect x="5" y="4" width="6" height="1" fill="#ffcc00"/>' +
          '<rect x="1" y="5" width="14" height="1" fill="#ffcc00"/>' +
          '<rect x="2" y="6" width="12" height="1" fill="#ffcc00"/>' +
          '<rect x="3" y="7" width="10" height="1" fill="#ffcc00"/>' +
          '<rect x="3" y="8" width="10" height="1" fill="#ffcc00"/>' +
          '<rect x="2" y="9" width="5" height="1" fill="#ffcc00"/>' +
          '<rect x="9" y="9" width="5" height="1" fill="#ffcc00"/>' +
          '<rect x="2" y="10" width="4" height="1" fill="#ffcc00"/>' +
          '<rect x="10" y="10" width="4" height="1" fill="#ffcc00"/>' +
          '<rect x="1" y="11" width="4" height="1" fill="#ffcc00"/>' +
          '<rect x="11" y="11" width="4" height="1" fill="#ffcc00"/>' +
          '<rect x="1" y="12" width="3" height="1" fill="#ffcc00"/>' +
          '<rect x="12" y="12" width="3" height="1" fill="#ffcc00"/>' +
          // Shine
          '<rect x="7" y="2" width="1" height="1" fill="#fff8c0"/>' +
          '<rect x="7" y="6" width="2" height="1" fill="#fff8c0"/>' +
          // Outline accents
          '<rect x="7" y="0" width="2" height="1" fill="#cc9900"/>' +
          '<rect x="0" y="5" width="1" height="1" fill="#cc9900"/>' +
          '<rect x="15" y="5" width="1" height="1" fill="#cc9900"/>' +
          '</svg>';
      }
    },
    {
      id: 'angry',
      label: '>:(',
      title: 'Angry',
      bg: '#cc0000',
      svg: function () {
        return '<svg viewBox="0 0 16 16" width="100%" height="100%" shape-rendering="crispEdges">' +
          '<rect width="16" height="16" fill="#c0c0c0"/>' +
          // Face
          '<rect x="4" y="1" width="8" height="1" fill="#000"/>' +
          '<rect x="3" y="2" width="1" height="1" fill="#000"/><rect x="12" y="2" width="1" height="1" fill="#000"/>' +
          '<rect x="2" y="3" width="1" height="2" fill="#000"/><rect x="13" y="3" width="1" height="2" fill="#000"/>' +
          '<rect x="1" y="5" width="1" height="6" fill="#000"/><rect x="14" y="5" width="1" height="6" fill="#000"/>' +
          '<rect x="2" y="11" width="1" height="2" fill="#000"/><rect x="13" y="11" width="1" height="2" fill="#000"/>' +
          '<rect x="3" y="13" width="1" height="1" fill="#000"/><rect x="12" y="13" width="1" height="1" fill="#000"/>' +
          '<rect x="4" y="14" width="8" height="1" fill="#000"/>' +
          // Fill red-tinted
          '<rect x="4" y="2" width="8" height="1" fill="#ff6040"/>' +
          '<rect x="3" y="3" width="10" height="2" fill="#ff6040"/>' +
          '<rect x="2" y="5" width="12" height="6" fill="#ff6040"/>' +
          '<rect x="3" y="11" width="10" height="2" fill="#ff6040"/>' +
          '<rect x="4" y="13" width="8" height="1" fill="#ff6040"/>' +
          // Angry brows
          '<rect x="3" y="4" width="1" height="1" fill="#000"/>' +
          '<rect x="4" y="5" width="1" height="1" fill="#000"/><rect x="5" y="5" width="1" height="1" fill="#000"/>' +
          '<rect x="12" y="4" width="1" height="1" fill="#000"/>' +
          '<rect x="10" y="5" width="1" height="1" fill="#000"/><rect x="11" y="5" width="1" height="1" fill="#000"/>' +
          // Eyes
          '<rect x="5" y="7" width="2" height="2" fill="#000"/>' +
          '<rect x="9" y="7" width="2" height="2" fill="#000"/>' +
          // Frown
          '<rect x="6" y="11" width="4" height="1" fill="#000"/>' +
          '<rect x="5" y="12" width="1" height="1" fill="#000"/>' +
          '<rect x="10" y="12" width="1" height="1" fill="#000"/>' +
          '</svg>';
      }
    }
  ];

  // ── Public: get emoji list ──
  window.__sonicEmojis = EMOJIS;

})();
