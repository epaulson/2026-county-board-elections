import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import geobuf from 'geobuf';
import Pbf from 'pbf';
import { centroid } from '@turf/centroid';

// Fix for default marker icons in Leaflet with bundlers
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Initialize the map centered over Madison, WI
const map = L.map('map').setView([43.0722, -89.4008], 11);

// Add OpenStreetMap tile layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// Load and parse CSV data
async function loadCandidates() {
  const response = await fetch('2026_dane_county_board_candidates.csv');
  const text = await response.text();
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  
  const candidates = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let currentValue = '';
    let inQuotes = false;
    
    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(currentValue.trim());
        currentValue = '';
      } else {
        currentValue += char;
      }
    }
    values.push(currentValue.trim());
    
    // Extract district number from office field (e.g., "County Supervisor - District 3" -> "03")
    const office = values[0];
    const match = office.match(/District (\d+)/);
    if (match) {
      const districtNum = match[1].padStart(2, '0'); // Pad to 2 digits like "03"
      const candidatesList = [];
      
      // Process up to 3 candidates with their websites
      for (let j = 0; j < 3; j++) {
        const candidateName = values[1 + j];
        const candidateWebsite = values[5 + j]; // websites are at indices 5, 6, 7
        
        if (candidateName && candidateName !== '') {
          candidatesList.push({
            name: candidateName,
            website: candidateWebsite && candidateWebsite !== '' ? candidateWebsite : null
          });
        }
      }
      
      // Parse presidential election data (PRETOT24, PREDEM24, PREREP24 at indices 11, 12, 13)
      const totalVotes = parseFloat(values[11]) || 0;
      const harrisVotes = parseFloat(values[12]) || 0;
      const trumpVotes = parseFloat(values[13]) || 0;
      
      let harrisPercent = null;
      if (totalVotes > 0) {
        harrisPercent = Math.round((harrisVotes / totalVotes) * 100);
      }
      
      candidates[districtNum] = {
        candidates: candidatesList,
        harrisPercent: harrisPercent
      };
    }
  }
  
  return candidates;
}

// Load and parse alders CSV data
async function loadAlders() {
  const response = await fetch('dane_county_alders.csv');
  const text = await response.text();
  const lines = text.trim().split('\n');
  
  const alders = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const values = [];
    let currentValue = '';
    let inQuotes = false;
    
    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(currentValue.trim());
        currentValue = '';
      } else {
        currentValue += char;
      }
    }
    values.push(currentValue.trim());
    
    // city, district, alder
    const city = values[0];
    const district = values[1].padStart(2, '0'); // Pad to 2 digits like "03"
    const alder = values[2].replace(/"/g, ''); // Remove quotes
    
    // Create key from city + district
    const key = `${city}-${district}`;
    alders[key] = { city, alder };
  }
  
  return alders;
}

// Load and display supervisor districts
async function loadSupervisorDistricts() {
  const [candidatesData, geoResponse] = await Promise.all([
    loadCandidates(),
    fetch('dane_county_supervisors.pbf')
  ]);
  
  const buffer = await geoResponse.arrayBuffer();
  const geojson = geobuf.decode(new Pbf(buffer));
  
  // Store globally for updates
  currentCandidatesData = candidatesData;
  currentGeojson = geojson;
  
  // Draw initial layers with shading enabled by default
  drawLayers(true);
}

// Load and display alder districts
async function loadAlderDistricts() {
  const [aldersData, geoResponse] = await Promise.all([
    loadAlders(),
    fetch('dane_county_alder_dists.pbf')
  ]);
  
  const buffer = await geoResponse.arrayBuffer();
  const geojson = geobuf.decode(new Pbf(buffer));
  
  // Store globally
  currentAldersData = aldersData;
  currentAldersGeojson = geojson;
  
  // Draw alder layer
  drawAlderLayer();
}

// Draw alder districts layer (drawn first, so it's below supervisor districts)
function drawAlderLayer() {
  if (alderLayer) map.removeLayer(alderLayer);
  if (alderLabelsLayer) map.removeLayer(alderLabelsLayer);
  
  alderLayer = L.geoJSON(currentAldersGeojson, {
    filter: (feature) => {
      const alderid = feature.properties.ALDERID;
      const muniName = feature.properties.MuniName;
      const key = `${muniName}-${alderid}`;
      return currentAldersData[key] !== undefined;
    },
    style: {
      fillColor: 'transparent',
      fillOpacity: 0,
      color: '#FFD700', // Golden yellow
      weight: 2,
      opacity: 0.7
    },
    interactive: false // Allow pointer events to pass through to layers below
  });
  
  if (aldersEnabled) {
    alderLayer.addTo(map);
  }
  
  // Create a layer group for labels
  alderLabelsLayer = L.layerGroup();
  
  // Add labels for each alder district
  currentAldersGeojson.features.forEach((feature) => {
    const alderid = feature.properties.ALDERID;
    const muniName = feature.properties.MuniName;
    const key = `${muniName}-${alderid}`;
    const alderInfo = currentAldersData[key];
    
    if (alderInfo) {
      // Calculate centroid for label placement
      const center = centroid(feature);
      const coords = center.geometry.coordinates;
      
      // Create div icon with text
      const labelText = `${alderInfo.city} D${parseInt(alderid)} - ${alderInfo.alder}`;
      const icon = L.divIcon({
        className: 'alder-label',
        html: `<span style="color: #FFD700; font-size: 11px; font-weight: bold; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000; white-space: nowrap; cursor: pointer;">${labelText}</span>`,
        iconSize: null
      });
      
      const marker = L.marker([coords[1], coords[0]], { icon: icon });
      
      // Add click handler to flash the district boundary
      marker.on('click', () => {
        flashAlderDistrict(feature);
      });
      
      alderLabelsLayer.addLayer(marker);
    }
  });
  
  updateAlderLabelsVisibility();
}

// Function to toggle alder layer visibility
function toggleAlderLayer(show) {
  if (alderLayer) {
    if (show) {
      if (!map.hasLayer(alderLayer)) {
        alderLayer.addTo(map);
        // Make sure it's on top of supervisor layers
        alderLayer.bringToFront();
      }
    } else {
      if (map.hasLayer(alderLayer)) {
        map.removeLayer(alderLayer);
      }
    }
  }
  updateAlderLabelsVisibility();
}

// Function to show/hide alder labels based on zoom level
function updateAlderLabelsVisibility() {
  const zoom = map.getZoom();
  const minZoom = 13; // Only show labels when zoomed in to level 13 or closer
  
  if (alderLabelsLayer && aldersEnabled) {
    if (zoom >= minZoom) {
      if (!map.hasLayer(alderLabelsLayer)) {
        alderLabelsLayer.addTo(map);
      }
    } else {
      if (map.hasLayer(alderLabelsLayer)) {
        map.removeLayer(alderLabelsLayer);
      }
    }
  } else if (alderLabelsLayer && !aldersEnabled) {
    if (map.hasLayer(alderLabelsLayer)) {
      map.removeLayer(alderLabelsLayer);
    }
  }
}

// Store reference to current flash layer
let currentFlashLayer = null;

// Function to flash an alder district boundary when clicked
function flashAlderDistrict(feature) {
  // Create a temporary layer for flashing
  const flashLayer = L.geoJSON(feature, {
    style: {
      fillColor: 'transparent',
      fillOpacity: 0,
      color: '#FFD700',
      weight: 5,
      opacity: 1
    }
  }).addTo(map);
  
  let flashCount = 0;
  const maxFlashes = 6; // Flash 6 times over 3 seconds
  const flashInterval = 500; // 500ms per flash (on/off cycle)
  
  const interval = setInterval(() => {
    flashCount++;
    
    // Toggle opacity between visible and invisible
    const currentOpacity = flashLayer.options.opacity;
    flashLayer.setStyle({
      opacity: currentOpacity > 0 ? 0 : 1
    });
    
    // Stop after specified number of flashes
    if (flashCount >= maxFlashes) {
      clearInterval(interval);
      map.removeLayer(flashLayer);
    }
  }, flashInterval);
}

// Function to flash a supervisor district boundary when clicked
function flashSupervisorDistrict(feature, borderColor) {
  // Remove any existing flash layer
  if (currentFlashLayer) {
    map.removeLayer(currentFlashLayer);
    currentFlashLayer = null;
  }
  
  // Create a temporary layer for highlighting
  currentFlashLayer = L.geoJSON(feature, {
    style: {
      fillColor: 'transparent',
      fillOpacity: 0,
      color: borderColor,
      weight: 6,
      opacity: 1
    }
  }).addTo(map);
}

// Function to clear the supervisor district highlight
function clearSupervisorHighlight() {
  if (currentFlashLayer) {
    map.removeLayer(currentFlashLayer);
    currentFlashLayer = null;
  }
}

// Function to update district shading
function updateDistrictShading(shadeEnabled) {
  // Remove existing layers
  if (greenLayer) map.removeLayer(greenLayer);
  if (redLayer) map.removeLayer(redLayer);
  if (defaultLayer) map.removeLayer(defaultLayer);
  
  // Redraw with new shading
  drawLayers(shadeEnabled);
}

// Function to draw all layers with specified shading
function drawLayers(shadeEnabled) {
  const fillOpacity = shadeEnabled ? 0.3 : 0.1;
  const baseFillColor = '#ffffff';
  
  // Helper function to create popup handler
  const createPopupHandler = (superid, districtData) => {
    return function(e) {
      const candidatesList = districtData.candidates || [];
      const harrisPercent = districtData.harrisPercent;
      
      const candidatesHTML = candidatesList.length > 0 
        ? candidatesList.map(c => {
            if (c.website) {
              return `• <a href="${c.website}" target="_blank" rel="noopener noreferrer">${c.name}</a>`;
            } else {
              return `• ${c.name}`;
            }
          }).join('<br/>') 
        : 'No candidates listed';
      
      const harrisPercentText = harrisPercent !== null ? ` (${harrisPercent}% Harris)` : '';
      
      const popup = L.popup()
        .setLatLng(e.latlng)
        .setContent(`
          <div style="font-family: sans-serif;">
            <strong>District ${parseInt(superid)}${harrisPercentText}</strong><br/>
            ${candidatesHTML}
          </div>
        `)
        .openOn(map);
      
      // Clear highlight when popup is closed
      popup.on('remove', clearSupervisorHighlight);
    };
  };
  
  // First, draw districts with single candidate (green borders)
  greenLayer = L.geoJSON(currentGeojson, {
    filter: (feature) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid];
      const candidateCount = districtData ? districtData.candidates.length : 0;
      return candidateCount === 1;
    },
    style: (feature) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid];
      const candidateCount = districtData ? districtData.candidates.length : 0;
      const fillColor = shadeEnabled ? getDistrictColor(superid, candidateCount) : baseFillColor;
      return {
        fillColor: fillColor,
        fillOpacity: fillOpacity,
        color: '#028c0b', // Dark pine green
        weight: 2,
        opacity: 0.8
      };
    },
    onEachFeature: (feature, layer) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid] || { candidates: [], harrisPercent: null };
      layer.on('click', (e) => {
        createPopupHandler(superid, districtData)(e);
        flashSupervisorDistrict(feature, '#028c0b');
      });
    }
  }).addTo(map);
  
  // Then, draw districts with multiple candidates (red borders) - these will be on top
  redLayer = L.geoJSON(currentGeojson, {
    filter: (feature) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid];
      const candidateCount = districtData ? districtData.candidates.length : 0;
      return candidateCount > 1;
    },
    style: (feature) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid];
      const candidateCount = districtData ? districtData.candidates.length : 0;
      const fillColor = shadeEnabled ? getDistrictColor(superid, candidateCount) : baseFillColor;
      return {
        fillColor: fillColor,
        fillOpacity: fillOpacity,
        color: '#ff0000',
        weight: 4,
        opacity: 0.9
      };
    },
    onEachFeature: (feature, layer) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid] || { candidates: [], harrisPercent: null };
      layer.on('click', (e) => {
        createPopupHandler(superid, districtData)(e);
        flashSupervisorDistrict(feature, '#ff0000');
      });
    }
  }).addTo(map);
  
  // Finally, draw districts with no candidates or zero candidates (default gray)
  defaultLayer = L.geoJSON(currentGeojson, {
    filter: (feature) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid];
      const candidateCount = districtData ? districtData.candidates.length : 0;
      return candidateCount === 0;
    },
    style: (feature) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid];
      const candidateCount = districtData ? districtData.candidates.length : 0;
      const fillColor = shadeEnabled ? getDistrictColor(superid, candidateCount) : baseFillColor;
      return {
        fillColor: fillColor,
        fillOpacity: fillOpacity,
        color: '#666',
        weight: 1,
        opacity: 0.8
      };
    },
    onEachFeature: (feature, layer) => {
      const superid = feature.properties.SUPERID;
      const districtData = currentCandidatesData[superid] || { candidates: [], harrisPercent: null };
      layer.on('click', (e) => {
        createPopupHandler(superid, districtData)(e);
        flashSupervisorDistrict(feature, '#666');
      });
    }
  }).addTo(map);
}

// Store layer references globally so we can update them
let greenLayer, redLayer, defaultLayer, alderLayer, alderLabelsLayer;
let currentCandidatesData;
let currentGeojson;
let currentAldersData;
let currentAldersGeojson;
let aldersEnabled = false;
let districtColors = {}; // Store random colors for each district

// Function to generate a random shade of green
function getRandomGreen() {
  // Generate random RGB values with green as the dominant color
  const red = Math.floor(Math.random() * 80 + 50); // 50-130
  const green = Math.floor(Math.random() * 100 + 155); // 155-255 (keep green dominant)
  const blue = Math.floor(Math.random() * 80 + 50); // 50-130
  return `rgb(${red}, ${green}, ${blue})`;
}

// Function to generate a random shade of red
function getRandomRed() {
  // Generate random RGB values with red as the dominant color
  const red = Math.floor(Math.random() * 100 + 155); // 155-255 (keep red dominant)
  const green = Math.floor(Math.random() * 80 + 50); // 50-130
  const blue = Math.floor(Math.random() * 80 + 50); // 50-130
  return `rgb(${red}, ${green}, ${blue})`;
}

// Function to generate a random shade of blue (for no candidates)
function getRandomBlue() {
  // Generate random RGB values with blue as the dominant color
  const red = Math.floor(Math.random() * 100 + 100); // 100-200
  const green = Math.floor(Math.random() * 100 + 100); // 100-200
  const blue = Math.floor(Math.random() * 100 + 155); // 155-255 (keep blue dominant)
  return `rgb(${red}, ${green}, ${blue})`;
}

// Function to get or create a color for a district
function getDistrictColor(superid, candidateCount) {
  if (!districtColors[superid]) {
    if (candidateCount === 1) {
      districtColors[superid] = getRandomGreen();
    } else if (candidateCount > 1) {
      districtColors[superid] = getRandomRed();
    } else {
      districtColors[superid] = getRandomBlue();
    }
  }
  return districtColors[superid];
}

// Initialize the map
// Load supervisors first, then alders on top
loadSupervisorDistricts().then(() => {
  return loadAlderDistricts();
}).then(() => {
  // Set up checkbox handlers
  const shadeCheckbox = document.getElementById('shadeDistricts');
  shadeCheckbox.addEventListener('change', () => {
    updateDistrictShading(shadeCheckbox.checked);
  });
  
  const aldersCheckbox = document.getElementById('showAlders');
  aldersCheckbox.addEventListener('change', () => {
    aldersEnabled = aldersCheckbox.checked;
    toggleAlderLayer(aldersEnabled);
  });
  
  // Set up zoom handler for alder labels
  map.on('zoomend', updateAlderLabelsVisibility);
  updateAlderLabelsVisibility(); // Initial check
  
  // Set up Help/About modal
  const helpBtn = document.getElementById('helpBtn');
  const helpModal = document.getElementById('helpModal');
  const helpModalClose = document.getElementById('helpModalClose');
  
  helpBtn.onclick = (e) => {
    e.preventDefault();
    helpModal.style.display = 'block';
    helpModal.classList.add('show');
  };
  
  helpModalClose.onclick = () => {
    helpModal.style.display = 'none';
    helpModal.classList.remove('show');
  };
  
  window.onclick = function(event) {
    if (event.target === helpModal) {
      helpModal.style.display = 'none';
      helpModal.classList.remove('show');
    }
  };
});
