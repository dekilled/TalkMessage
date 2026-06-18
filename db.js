const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function load(filename) {
    try {
        return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
    } catch {
        return [];
    }
}

function save(filename, arr) {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(arr, null, 2));
}

module.exports = {
    loadAppointments: () => load('appointments.json'),
    saveAppointments: (arr) => save('appointments.json', arr),
    loadCompleted: () => load('completed.json'),
    saveCompleted: (arr) => save('completed.json', arr),
};
