export async function getFireWeather(latitude, longitude) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude,
    longitude,
    current: "temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m",
    daily: "precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
    timezone: "Asia/Kolkata",
    forecast_days: "1"
  });

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Weather request failed (${response.status})`);
  const data = await response.json();
  return {
    source: "Open-Meteo",
    observedAt: data.current.time,
    temperature: data.current.temperature_2m,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    precipitation: data.current.precipitation,
    rainChance: data.daily.precipitation_probability_max[0],
    windMaximum: data.daily.wind_speed_10m_max[0]
  };
}
