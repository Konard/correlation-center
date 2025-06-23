import { Low, JSONFile } from 'lowdb';

class Storage {
  constructor() {
    this.adapter = new JSONFile('db.json');
    this.db = new Low(this.adapter);
  }

  async initDB() {
    await this.db.read();
    this.db.data ||= { users: {} };
    await this.db.write();
  }

  async getUserData(userId) {
    // Ensure latest data is loaded before accessing user
    await this.db.read();
    this.db.data ||= { users: {} };
    const id = String(userId);
    if (!this.db.data.users[id]) {
      this.db.data.users[id] = { needs: [], resources: [] };
    }
    return this.db.data.users[id];
  }

  async readDB() {
    await this.db.read();
  }

  async writeDB() {
    await this.db.write();
  }
}

export default Storage;
