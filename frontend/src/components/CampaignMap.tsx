import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import type { CampaignSummary } from '../types/campaign';
import { formatXecFromSats } from '../utils/amount';

const defaultIcon = L.icon({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

L.Marker.prototype.options.icon = defaultIcon;

function createPopupContent(campaign: CampaignSummary): HTMLElement {
  const container = document.createElement('div');

  const title = document.createElement('div');
  title.style.fontWeight = '600';
  title.textContent = campaign.name;
  container.appendChild(title);

  const goal = document.createElement('div');
  goal.textContent = `Meta: ${formatXecFromSats(campaign.goal)} XEC`;
  container.appendChild(goal);

  const link = document.createElement('a');
  link.href = `/campaigns/${campaign.id}`;
  link.textContent = 'Ver campana';
  link.style.display = 'inline-block';
  link.style.marginTop = '6px';
  container.appendChild(link);

  return container;
}

export const CampaignMap: React.FC = () => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/campaigns')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Error ${res.status}`);
        }
        return res.json() as Promise<CampaignSummary[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setCampaigns(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'No se pudo cargar el mapa.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeWithLocation = useMemo(
    () =>
      campaigns.filter(
        (campaign) => (!campaign.status || campaign.status === 'active') && campaign.location,
      ),
    [campaigns],
  );

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapContainerRef.current).setView([20, 0], 2);
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) {
      return;
    }

    markers.clearLayers();
    if (activeWithLocation.length === 0) {
      return;
    }

    const bounds = L.latLngBounds([]);
    activeWithLocation.forEach((campaign) => {
      const location = campaign.location;
      if (!location) return;
      const marker = L.marker([location.latitude, location.longitude]);
      marker.bindPopup(createPopupContent(campaign));
      marker.addTo(markers);
      bounds.extend([location.latitude, location.longitude]);
    });

    if (activeWithLocation.length === 1) {
      map.setView(bounds.getCenter(), 9);
    } else {
      map.fitBounds(bounds, { padding: [24, 24] });
    }
  }, [activeWithLocation]);

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h3>Campanas activas en el mapa</h3>
        {error && <span style={{ color: '#b00020' }}>{error}</span>}
      </div>
      {activeWithLocation.length === 0 && !error && (
        <p>No hay campanas activas con ubicacion.</p>
      )}
      <div
        ref={mapContainerRef}
        style={{
          height: 360,
          width: '100%',
          borderRadius: 12,
          border: '1px solid #e2e2e2',
          overflow: 'hidden',
        }}
      />
    </section>
  );
};

export default CampaignMap;
