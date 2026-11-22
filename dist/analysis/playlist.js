                                                                    

                                
                     
                      
                       
                     
 

export function confirmedEntries(groups              )                  {
  return groups
    .flatMap((group, groupIndex) =>
      group.status === "confirmed"
        ? group.occurrences.map((occurrence, takeIndex) => ({
            group: groupIndex + 1,
            take: takeIndex + 1,
            start: occurrence.start,
            end: occurrence.end,
            score: occurrence.score,
          }))
        : [],
    )
    .sort((a, b) => a.start - b.start);
}

function timecode(value        )         {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.floor(value % 60);
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function buildM3U8(input               )         {
  const entries = confirmedEntries(input.groups);
  const sourceName = input.sourceName.replace(/[\r\n]/g, " ").trim() || "audio";
  const lines = [
    "#EXTM3U",
    "#EXTENC:UTF-8",
    `#PLAYLIST:Echo Takes · ${sourceName}`,
  ];
  for (const entry of entries) {
    const duration = entry.end - entry.start;
    lines.push(
      `#EXTINF:${duration.toFixed(3)},命中 ${String(entry.group).padStart(2, "0")}-${String(entry.take).padStart(2, "0")} · ${Math.round(entry.score * 100)}% · ${timecode(entry.start)}`,
      `#EXTVLCOPT:start-time=${entry.start.toFixed(3)}`,
      `#EXTVLCOPT:stop-time=${entry.end.toFixed(3)}`,
      sourceName,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildManifest(input               )         {
  const entries = confirmedEntries(input.groups);
  const totalSec = entries.reduce((sum, item) => sum + item.end - item.start, 0);
  return JSON.stringify(
    {
      format: "echo-takes-hit-list",
      version: 1,
      source: input.sourceName,
      sourceDurationSec: Number(input.durationSec.toFixed(3)),
      generatedAt: (input.generatedAt ?? new Date()).toISOString(),
      confirmedGroups: input.groups.filter((group) => group.status === "confirmed")
        .length,
      hitCount: entries.length,
      totalHitSec: Number(totalSec.toFixed(3)),
      entries: entries.map((entry) => ({
        group: entry.group,
        take: entry.take,
        startSec: Number(entry.start.toFixed(3)),
        endSec: Number(entry.end.toFixed(3)),
        score: Number(entry.score.toFixed(4)),
      })),
    },
    null,
    2,
  );
}
