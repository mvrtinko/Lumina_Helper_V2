export async function renameVoiceChannel(client, voiceChannelId, newName) {
  if (!voiceChannelId) return;
  try {
    const vc = await client.channels.fetch(voiceChannelId);
    if (vc && vc.manageable && vc.setName) await vc.setName(newName);
  } catch (e) { console.error('Voice rename failed', e); }
}

export async function findVoiceAndModelForTextChannel(client, textChannelId, fallbackModel='Model') {
  try {
    const textCh = await client.channels.fetch(textChannelId);
    if (!textCh || !('parentId' in textCh)) return { voiceChannelId: null, modelName: fallbackModel };

    const guild = await client.guilds.fetch(textCh.guildId);
    const parentId = textCh.parentId || null;
    const modelName =
      (parentId && (await guild.channels.fetch(parentId))?.name) ||
      (textCh.name.includes('-') ? textCh.name.split('-')[0] : textCh.name) ||
      fallbackModel;

    if (!parentId) return { voiceChannelId: null, modelName };
    const all = await guild.channels.fetch();
    const voiceInCategory = [...all.values()].filter(
      (c) => c && c.type === 2 /* GuildVoice */ && c.parentId === parentId
    );
    const voiceChannelId = voiceInCategory.length === 1 ? voiceInCategory[0].id : null;
    return { voiceChannelId, modelName };
  } catch {
    return { voiceChannelId: null, modelName: fallbackModel };
  }
}
